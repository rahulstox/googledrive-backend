import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import mongoose from "mongoose";

// Mock Resend
vi.mock("resend", () => {
  return {
    Resend: vi.fn(function () {
      this.emails = { send: vi.fn() };
    }),
  };
});

import * as emailService from "../services/emailService.js";
import authRoutes from "../routes/authRoutes.js";
import User from "../models/User.js";
import PasswordResetToken from "../models/PasswordResetToken.js";

// Mock dependencies
vi.mock("../models/User.js");
vi.mock("../models/PasswordResetToken.js");
vi.mock("../services/emailService.js");
vi.mock("../services/metrics.js", () => ({
  registrationTotal: { inc: vi.fn() },
  registrationDuration: { startTimer: () => vi.fn() },
  emailSendTotal: { inc: vi.fn() },
  activationTotal: { inc: vi.fn() },
  loginDuration: { startTimer: () => vi.fn() },
  metricsRegistry: {},
}));
vi.mock("../services/cacheService.js", () => ({
  cache: {
    del: vi.fn(),
    set: vi.fn(),
  },
}));

// Mock mongoose session
mongoose.startSession = vi.fn().mockResolvedValue({
  startTransaction: vi.fn(),
  commitTransaction: vi.fn(),
  abortTransaction: vi.fn(),
  endSession: vi.fn(),
});

const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use("/api/auth", authRoutes);

describe("Password Recovery Flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = "test-secret";
    // Mock for all tests
    emailService.sendPasswordChangedEmail.mockResolvedValue({});
    emailService.sendPasswordResetEmail.mockResolvedValue({});
  });

  describe("Forgot Password Rate Limiting", () => {
    it("should limit requests to 3 per hour", async () => {
      const email = "rate@example.com";
      User.findOne.mockResolvedValue({ _id: "u1", email });
      PasswordResetToken.create.mockResolvedValue({});
      emailService.sendPasswordResetEmail.mockResolvedValue({});

      // 3 successful requests
      for (let i = 0; i < 3; i++) {
        const res = await request(app)
          .post("/api/auth/forgot-password")
          .send({ email });
        expect(res.status).toBe(204);
      }

      // 4th request should fail
      const res = await request(app)
        .post("/api/auth/forgot-password")
        .send({ email });

      expect(res.status).toBe(429);
      expect(res.text).toContain("Too many requests");
    });
  });

  describe("Token Generation", () => {
    it("should generate a token valid for 24 hours", async () => {
      const email = "test@example.com";
      User.findOne.mockResolvedValue({ _id: "u1", email, username: "test" });

      let createdTokenData;
      PasswordResetToken.create.mockImplementation((data) => {
        createdTokenData = data;
        return Promise.resolve(data);
      });

      emailService.sendPasswordResetEmail.mockResolvedValue({});

      await request(app)
        .post("/api/auth/forgot-password")
        .set("X-Forwarded-For", "1.2.3.4")
        .send({ email });

      expect(PasswordResetToken.create).toHaveBeenCalled();
      expect(createdTokenData).toBeDefined();
      const now = Date.now();
      const expires = new Date(createdTokenData.expiresAt).getTime();
      const diffHours = (expires - now) / (1000 * 60 * 60);

      // Should be close to 24 hours (allowing for small execution delay)
      expect(diffHours).toBeGreaterThan(23.9);
      expect(diffHours).toBeLessThan(24.1);
    });
  });

  describe("Reset Password Validation", () => {
    it("should accept passwords with special characters", async () => {
      const validPasswords = [
        "Password123!",
        "Password123#",
        "Password123.",
        "Password123_",
      ];

      // Mock User and Token lookup for the route handler
      User.findOne.mockReturnValue({
        session: vi.fn().mockResolvedValue({
          _id: "u1",
          email: "test@example.com",
          password: "old",
          save: vi.fn(),
        }),
      });

      PasswordResetToken.findOne.mockReturnValue({
        session: vi.fn().mockResolvedValue({
          userId: "u1",
          expiresAt: Date.now() + 10000,
          consumed: false,
          save: vi.fn(),
        }),
      });

      for (const pwd of validPasswords) {
        const res = await request(app).post("/api/auth/reset-password").send({
          token: "valid-token",
          email: "test@example.com",
          newPassword: pwd,
        });

        // If validation fails, it returns 400 with validation errors.
        // If validation passes, it proceeds to logic (which might fail or succeed 204).
        // We expect 204 because we mocked everything to succeed.
        if (res.status !== 204) {
          console.log(`Failed password: ${pwd}`, res.body);
        }
        expect(res.status).toBe(204);
      }
    });

    it("should reject weak passwords", async () => {
      const weakPasswords = [
        "short",
        "no_uppercase_1",
        "NO_LOWERCASE_1",
        "NoNumber!",
        "NoSpecialChar1",
      ];

      for (const pwd of weakPasswords) {
        const res = await request(app).post("/api/auth/reset-password").send({
          token: "valid-token",
          email: "test@example.com",
          newPassword: pwd,
        });
        expect(res.status).toBe(400); // Validation error
      }
    });
  });
});
