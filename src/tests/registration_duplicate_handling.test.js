import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import User from "../models/User.js";

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

const app = express();
app.use(express.json());
app.use("/api/auth", authRoutes);

// Helper for mocking Mongoose query chain
const mockMongooseQuery = (result) => {
  const query = {
    select: vi.fn().mockReturnThis(),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
    [Symbol.toStringTag]: "Promise",
  };
  return query;
};

describe("Registration Duplicate Handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = "test-secret";
  });

  it("should block registration if active user exists", async () => {
    const existingUser = {
      _id: "active123",
      email: "active@example.com",
      isActive: true,
    };
    User.findOne.mockReturnValue(mockMongooseQuery(existingUser));

    const res = await request(app).post("/api/auth/register").send({
      email: "active@example.com",
      password: "Password123!",
      username: "testuser",
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe("An account with this email already exists.");
  });

  it("should REUSE existing token if valid (>2 mins left)", async () => {
    const saveMock = vi.fn();
    const validToken = "valid-token-123";
    // 5 minutes from now
    const validExpires = new Date(Date.now() + 5 * 60 * 1000);

    const existingUser = {
      _id: "inactive123",
      email: "reuse@example.com",
      isActive: false,
      activationToken: validToken,
      activationTokenExpires: validExpires,
      save: saveMock,
    };

    User.findOne.mockReturnValue(mockMongooseQuery(existingUser));
    emailService.sendActivationEmail.mockResolvedValue({});

    const res = await request(app).post("/api/auth/register").send({
      email: "reuse@example.com",
      password: "Password123!",
      username: "testuser",
    });

    expect(res.status).toBe(200);
    expect(res.body.message).toContain("Account created");

    // Should NOT save new token
    expect(saveMock).not.toHaveBeenCalled();

    // Should send email with OLD token
    expect(emailService.sendActivationEmail).toHaveBeenCalledWith(
      "reuse@example.com",
      "User",
      expect.stringContaining(`token=${validToken}`),
    );
  });

  it("should GENERATE NEW token if existing is expired or expiring soon", async () => {
    const saveMock = vi.fn();
    const oldToken = "old-token-123";
    // 1 minute from now (less than 2 mins buffer)
    const expiringSoon = new Date(Date.now() + 1 * 60 * 1000);

    const existingUser = {
      _id: "inactive123",
      email: "expire@example.com",
      isActive: false,
      activationToken: oldToken,
      activationTokenExpires: expiringSoon,
      save: saveMock,
    };

    User.findOne.mockReturnValue(mockMongooseQuery(existingUser));
    emailService.sendActivationEmail.mockResolvedValue({});

    const res = await request(app).post("/api/auth/register").send({
      email: "expire@example.com",
      password: "Password123!",
      username: "testuser",
    });

    expect(res.status).toBe(200);

    // Should save new token
    expect(saveMock).toHaveBeenCalled();
    expect(existingUser.activationToken).not.toBe(oldToken);

    // Should send email with NEW token (not checking exact value, just that it was sent)
    expect(emailService.sendActivationEmail).toHaveBeenCalled();
  });
});
