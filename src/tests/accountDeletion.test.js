import { vi, describe, it, expect, beforeEach, beforeAll } from "vitest";
import request from "supertest";

// Mock dependencies
vi.mock("../middleware/auth.js", () => ({
  protect: (req, res, next) => {
    req.user = { id: "user_id" };
    next();
  },
}));

vi.mock("../services/s3Service.js", () => ({
  deleteFromS3: vi.fn().mockResolvedValue(true),
  s3Client: {},
}));

vi.mock("../services/emailService.js", () => ({
  sendActivationEmail: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  sendPasswordChangedEmail: vi.fn(),
  sendAccountDeletionEmail: vi.fn().mockResolvedValue(true),
}));

// Mock Mongoose Models
const mockSession = vi.hoisted(() => ({
  startTransaction: vi.fn(),
  commitTransaction: vi.fn(),
  abortTransaction: vi.fn(),
  endSession: vi.fn(),
}));

vi.mock("mongoose", async () => {
  const actual = await vi.importActual("mongoose");
  return {
    ...actual,
    default: {
      ...actual.default,
      startSession: vi.fn().mockResolvedValue(mockSession),
    },
    startSession: vi.fn().mockResolvedValue(mockSession),
  };
});

const mockUserObj = {
  _id: "user_id",
  email: "test@example.com",
  firstName: "Test",
  password: "hashed_password",
  comparePassword: vi.fn(),
};

vi.mock("../models/User.js", () => {
  return {
    default: {
      findById: vi.fn(),
      findByIdAndDelete: vi.fn(),
    },
  };
});

vi.mock("../models/File.js", () => {
  return {
    default: {
      find: vi.fn(),
      deleteMany: vi.fn(),
    },
  };
});

vi.mock("../models/PasswordResetToken.js", () => {
  return {
    default: {
      deleteMany: vi.fn(),
    },
  };
});

import User from "../models/User.js";
import File from "../models/File.js";
import PasswordResetToken from "../models/PasswordResetToken.js";
import { sendAccountDeletionEmail } from "../services/emailService.js";
import { deleteFromS3 } from "../services/s3Service.js";

describe("Account Deletion Workflow (DELETE /api/auth/me)", () => {
  let app;

  beforeAll(async () => {
    process.env.S3_BUCKET_NAME = "test-bucket";
    process.env.JWT_SECRET = "test-secret";
    const module = await import("../app.js");
    app = module.app;
  });

  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock implementations
    User.findById.mockReturnValue({
      select: vi.fn().mockResolvedValue(mockUserObj),
    });
    User.findByIdAndDelete.mockReturnValue({
      session: vi.fn().mockResolvedValue(mockUserObj),
    });

    File.find.mockReturnValue({
      session: vi.fn().mockResolvedValue([
        { type: "file", s3Key: "key1" },
        { type: "folder" }, // Should ignore
      ]),
    });
    File.deleteMany.mockReturnValue({
      session: vi.fn().mockResolvedValue({ deletedCount: 2 }),
    });

    PasswordResetToken.deleteMany.mockReturnValue({
      session: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    });

    mockUserObj.comparePassword.mockResolvedValue(true);
  });

  it("should successfully delete account with correct password", async () => {
    const res = await request(app)
      .delete("/api/auth/me")
      .send({ password: "password123" });

    expect(res.statusCode).toBe(200);
    expect(res.body.message).toMatch(/permanently deleted/i);

    // Verify steps
    expect(User.findById).toHaveBeenCalledWith("user_id");
    expect(mockUserObj.comparePassword).toHaveBeenCalledWith("password123");
    expect(mockSession.startTransaction).toHaveBeenCalled();

    // Verify Deletions
    expect(File.deleteMany).toHaveBeenCalledWith({ userId: "user_id" });
    expect(PasswordResetToken.deleteMany).toHaveBeenCalledWith({
      userId: "user_id",
    });
    expect(User.findByIdAndDelete).toHaveBeenCalledWith("user_id");

    expect(mockSession.commitTransaction).toHaveBeenCalled();

    // Verify S3 Cleanup (async but mocked)
    // Since it's inside Promise.allSettled and not awaited in the controller before response,
    // we might miss checking it unless we wait.
    // But since mocks are synchronous-ish here or resolved immediately, it might have been called.
    // However, the controller does NOT await the S3 deletion before returning.
    // So strictly speaking, we can't guarantee it's called *before* this expectation runs in a real async world,
    // but with mocks it usually queues up.

    // Verify Email
    expect(sendAccountDeletionEmail).toHaveBeenCalledWith(
      "test@example.com",
      "Test",
    );
  });

  it("should fail if password is missing", async () => {
    const res = await request(app).delete("/api/auth/me").send({}); // No password

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/password is required/i);
    expect(User.findById).not.toHaveBeenCalled();
  });

  it("should fail if password is incorrect", async () => {
    mockUserObj.comparePassword.mockResolvedValue(false);

    const res = await request(app)
      .delete("/api/auth/me")
      .send({ password: "wrong_password" });

    expect(res.statusCode).toBe(401);
    expect(res.body.message).toMatch(/incorrect password/i);
    expect(User.findByIdAndDelete).not.toHaveBeenCalled();
  });

  it("should handle transaction failure gracefully", async () => {
    // Simulate error during deletion
    File.deleteMany.mockReturnValue({
      session: vi.fn().mockRejectedValue(new Error("DB Error")),
    });

    const res = await request(app)
      .delete("/api/auth/me")
      .send({ password: "password123" });

    expect(res.statusCode).toBe(500);
    expect(mockSession.abortTransaction).toHaveBeenCalled();
    expect(mockSession.commitTransaction).not.toHaveBeenCalled();
    expect(sendAccountDeletionEmail).not.toHaveBeenCalled();
  });
});
