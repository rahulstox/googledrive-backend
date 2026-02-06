import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import User from "../models/User.js";

// Mock Resend to avoid "Missing API key" error during import of emailService
vi.mock("resend", () => {
  return {
    Resend: vi.fn(function () {
      this.emails = { send: vi.fn() };
    }),
  };
});

import * as emailService from "../services/emailService.js";
import authRoutes from "../routes/authRoutes.js";

// Mock dependencies
vi.mock("../models/User.js");
vi.mock("../services/emailService.js");
vi.mock("../services/metrics.js", () => ({
  registrationTotal: { inc: vi.fn() },
  registrationDuration: { startTimer: () => vi.fn() },
  emailSendTotal: { inc: vi.fn() },
  activationTotal: { inc: vi.fn() },
  metricsRegistry: {},
}));

// Helper for mocking Mongoose query chain
const mockMongooseQuery = (result) => {
  return {
    select: vi.fn().mockReturnThis(),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
};

const app = express();
app.use(express.json());
app.use("/api/auth", authRoutes);

describe("Registration & Activation Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Registration Workflow", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      process.env.JWT_SECRET = "test-secret";
      process.env.FRONTEND_URL = "http://localhost:3000";
    });

    it("should register a new user successfully and send activation email", async () => {
      User.findOne.mockReturnValue(mockMongooseQuery(null));
      User.create.mockResolvedValue({
        _id: "user123",
        email: "test@example.com",
        username: "testuser",
      });
      emailService.sendActivationEmail.mockResolvedValue({
        messageId: "msg123",
      });

      const res = await request(app).post("/api/auth/register").send({
        email: "test@example.com",
        username: "testuser",
        password: "Password123!",
      });

      expect(res.status).toBe(201);
      expect(User.create).toHaveBeenCalled();
      expect(emailService.sendActivationEmail).toHaveBeenCalled();

      // Verify JWT token in the link
      const link = emailService.sendActivationEmail.mock.calls[0][2];
      expect(link).toContain("http://localhost:3000/activate?token=");
      const token = link.split("token=")[1];
      const decoded = jwt.verify(token, "test-secret");
      expect(decoded.email).toBe("test@example.com");
    });

    it("should generate HTTPS link when FRONTEND_URL is https", async () => {
      process.env.FRONTEND_URL = "https://krypton.com";
      User.findOne.mockReturnValue(mockMongooseQuery(null));
      User.create.mockResolvedValue({ _id: "u1", email: "https@test.com" });
      emailService.sendActivationEmail.mockResolvedValue({});

      await request(app).post("/api/auth/register").send({
        email: "https@test.com",
        username: "httpstest",
        password: "Password123!",
      });

      const link = emailService.sendActivationEmail.mock.calls[0][2];
      expect(link).toContain("https://krypton.com/activate?token=");
    });

    it("should handle email sending timeout gracefully", async () => {
      User.findOne.mockReturnValue(mockMongooseQuery(null));
      User.create.mockResolvedValue({ _id: "user123" });

      // Simulate slow email
      emailService.sendActivationEmail.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 6000)),
      );

      const start = Date.now();
      const res = await request(app).post("/api/auth/register").send({
        email: "timeout@example.com",
        username: "timeoutuser",
        password: "Password123!",
      });
      const duration = Date.now() - start;

      expect(res.status).toBe(201); // Should still succeed
      expect(duration).toBeLessThan(6500); // Should be around 5000ms + overhead
    }, 10000); // Increase test timeout

    it("should reject existing users", async () => {
      User.findOne.mockReturnValue(
        mockMongooseQuery({ email: "existing@example.com", isActive: true }),
      );

      const res = await request(app).post("/api/auth/register").send({
        email: "existing@example.com",
        username: "existinguser",
        password: "Password123!",
      });

      expect(res.status).toBe(400);
    });
  });

  describe("Resend Activation Workflow", () => {
    it("should resend activation email for inactive user", async () => {
      const mockSave = vi.fn();
      const mockUser = {
        email: "test@example.com",
        username: "testuser",
        isActive: false,
        save: mockSave,
      };

      User.findOne.mockResolvedValue(mockUser);
      emailService.sendActivationEmail.mockResolvedValue({ messageId: "123" });

      const res = await request(app)
        .post("/api/auth/resend-activation")
        .send({ email: "test@example.com" });

      expect(res.status).toBe(200);
      expect(mockSave).toHaveBeenCalled();
      expect(emailService.sendActivationEmail).toHaveBeenCalled();
    });

    it("should return success for non-existent user (security)", async () => {
      User.findOne.mockResolvedValue(null);

      const res = await request(app)
        .post("/api/auth/resend-activation")
        .send({ email: "nobody@example.com" });

      expect(res.status).toBe(200);
      expect(res.body.message).toContain("activation email sent");
    });

    it("should rate limit resend requests", async () => {
      // Send 6 requests (limit is 5)
      const email = "rate@example.com";
      User.findOne.mockResolvedValue({ email, isActive: false, save: vi.fn() });
      emailService.sendActivationEmail.mockResolvedValue({});

      for (let i = 0; i < 5; i++) {
        await request(app).post("/api/auth/resend-activation").send({ email });
      }

      const res = await request(app)
        .post("/api/auth/resend-activation")
        .send({ email });

      expect(res.status).toBe(429);
      expect(res.text).toContain("Too many resend requests");
    });
  });
});

describe("Activation Workflow", () => {
  it("should activate user with valid token", async () => {
    const token = jwt.sign({ email: "test@example.com" }, "test-secret", {
      expiresIn: "1h",
    });

    const mockSave = vi.fn();
    const mockUser = {
      _id: "user123",
      email: "test@example.com",
      activationToken: token,
      activationTokenExpires: Date.now() + 3600000,
      save: mockSave,
      toObject: function () {
        return this;
      },
      getSignedJwtToken: function () {
        return "fake-jwt-token";
      },
    };

    User.findOne.mockReturnValue(mockMongooseQuery(mockUser));
    // Mock cache service which is used in authRoutes
    vi.mock("../services/cacheService.js", () => ({
      cache: {
        del: vi.fn(),
        set: vi.fn(),
      },
    }));

    const res = await request(app).get("/api/auth/activate").query({ token });

    expect(res.status).toBe(200);
    expect(mockUser.isActive).toBe(true);
    expect(mockUser.activationToken).toBeUndefined();
    expect(mockSave).toHaveBeenCalled();
    expect(res.body.token).toBe("fake-jwt-token");
  });
});
