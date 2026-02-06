import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
// Note: We must mock mongoose BEFORE importing routes that use it
vi.mock("mongoose", async () => {
  const actual = await vi.importActual("mongoose");
  const session = {
    startTransaction: vi.fn(),
    commitTransaction: vi.fn(),
    abortTransaction: vi.fn(),
    endSession: vi.fn(),
  };
  return {
    ...actual,
    default: {
      ...actual.default,
      startSession: vi.fn().mockResolvedValue(session),
    },
    startSession: vi.fn().mockResolvedValue(session),
  };
});

import User from "../models/User.js";
import authRoutes from "../routes/authRoutes.js";
import { protect } from "../middleware/auth.js";

// Mock dependencies
vi.mock("../models/User.js");
vi.mock("../services/emailService.js", () => ({
  sendAccountDeletionEmail: vi.fn().mockResolvedValue({}),
  sendActivationEmail: vi.fn().mockResolvedValue({}),
}));
vi.mock("../services/s3Service.js", () => ({
  deleteFromS3: vi.fn().mockResolvedValue({}),
}));
vi.mock("../models/File.js", () => ({
  default: {
    find: vi.fn().mockReturnValue({ session: () => [] }),
    deleteMany: vi.fn().mockReturnValue({ session: () => {} }),
  },
}));
vi.mock("../models/PasswordResetToken.js", () => ({
  default: {
    deleteMany: vi.fn().mockReturnValue({ session: () => {} }),
  },
}));

// Helper for mocking Mongoose query chain
const mockMongooseQuery = (result) => {
  return {
    select: vi.fn().mockReturnThis(),
    session: vi.fn().mockReturnThis(),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
};

const app = express();
app.use(express.json());
app.use("/api/auth", authRoutes);

describe("Account Deletion Workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = "test-secret";
  });

  it("should delete unactivated account successfully (Fix Verification)", async () => {
    // 1. Mock user as NOT active
    const mockUser = {
      _id: "user123",
      email: "inactive@example.com",
      username: "inactiveuser",
      isActive: false, // Inactive user
      password: "hashedPassword",
      comparePassword: vi.fn().mockResolvedValue(true),
      save: vi.fn(),
      toObject: function () {
        return this;
      }, // Mock toObject for cacheService
    };

    // Mock User.findById for middleware and route
    // Note: protect/authenticate calls findById, then route calls findById again.
    // We can use mockReturnValue which returns the same object/query chain each time.
    User.findById.mockImplementation(() => mockMongooseQuery(mockUser));
    User.findByIdAndDelete = vi.fn().mockReturnValue({ session: () => {} });

    // Generate a valid token
    const token = jwt.sign({ id: "user123" }, "test-secret");

    // 2. Attempt deletion
    const res = await request(app)
      .delete("/api/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .send({ password: "password" });

    // 3. Assert SUCCESS (Changed from failure expectation)
    expect(res.status).toBe(200);
    expect(res.body.message).toContain("permanently deleted");
  });

  it("should delete activated account successfully", async () => {
    // 1. Mock user as ACTIVE
    const mockUser = {
      _id: "user123",
      email: "active@example.com",
      username: "activeuser",
      isActive: true,
      password: "hashedPassword",
      comparePassword: vi.fn().mockResolvedValue(true),
      save: vi.fn(),
      toObject: function () {
        return this;
      },
    };

    User.findById.mockImplementation(() => mockMongooseQuery(mockUser));
    User.findByIdAndDelete = vi.fn().mockReturnValue({ session: () => {} });

    // Generate a valid token
    const token = jwt.sign({ id: "user123" }, "test-secret");

    // 2. Attempt deletion
    const res = await request(app)
      .delete("/api/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .send({ password: "password" });

    // 3. Assert success
    expect(res.status).toBe(200);
    expect(res.body.message).toContain("permanently deleted");
  });

  it("should still require authentication", async () => {
    const res = await request(app)
      .delete("/api/auth/me")
      .send({ password: "password" });

    expect(res.status).toBe(401);
  });
});
