import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import authRoutes from "../routes/authRoutes.js";
import { cache } from "../services/cacheService.js";

// Mock dependencies
vi.mock("../models/User.js");
vi.mock("../services/emailService.js", () => ({
  sendActivationEmail: vi.fn(),
}));
vi.mock("../services/cacheService.js", () => ({
  cache: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    isEnabled: () => true,
  },
}));

// Setup App
const app = express();
app.use(express.json());
app.use("/api/auth", authRoutes);

describe("Inactive User Login Prevention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = "test-secret";
  });

  it("should block login for inactive users with 403", async () => {
    const mockUser = {
      _id: "user123",
      email: "inactive@example.com",
      password: "hashedPassword",
      isActive: false, // Inactive
      comparePassword: vi.fn().mockResolvedValue(true),
      getSignedJwtToken: vi.fn().mockReturnValue("valid-token"),
      toObject: function () {
        return this;
      },
    };

    User.findOne = vi.fn().mockImplementation(() => ({
      select: vi.fn().mockResolvedValue(mockUser),
    }));

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "inactive@example.com", password: "password" });

    expect(res.status).toBe(403);
    expect(res.body.message).toContain("Account not activated");
  });

  it("should allow login for active users", async () => {
    const mockUser = {
      _id: "user123",
      email: "active@example.com",
      password: "hashedPassword",
      username: "activeuser",
      isActive: true, // Active
      loginHistory: [],
      comparePassword: vi.fn().mockResolvedValue(true),
      getSignedJwtToken: vi.fn().mockReturnValue("valid-token"),
      save: vi.fn().mockResolvedValue(true),
      toObject: function () {
        return this;
      },
    };

    User.findOne = vi.fn().mockImplementation(() => ({
      select: vi.fn().mockResolvedValue(mockUser),
    }));

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "active@example.com", password: "password" });

    expect(res.status).toBe(200);
    expect(res.body.token).toBe("valid-token");
  });
});
