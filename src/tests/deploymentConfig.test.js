import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { app } from "../app.js";
import User from "../models/User.js";
import PasswordResetToken from "../models/PasswordResetToken.js";
import * as emailService from "../services/emailService.js";

// Mock Resend to avoid "Missing API key" error
vi.mock("resend", () => {
  return {
    Resend: vi.fn(function () {
      this.emails = { send: vi.fn() };
    }),
  };
});

// Mock dependencies
vi.mock("../models/User.js");
vi.mock("../models/PasswordResetToken.js");
vi.mock("../services/emailService.js");
vi.mock("../services/s3Service.js", () => ({
  checkS3Connection: vi.fn(),
  s3Client: {},
}));

// Mock Multer and S3 to avoid import errors in fileRoutes
vi.mock("multer", () => ({
  default: () => ({
    single: () => (req, res, next) => next(),
    array: () => (req, res, next) => next(),
  }),
}));
vi.mock("multer-s3", () => ({
  default: () => ({}),
  AUTO_CONTENT_TYPE: "auto",
}));

// Mock rate limiters to avoid blocking tests
vi.mock("express-rate-limit", () => ({
  default: vi.fn(() => (req, res, next) => next()),
  rateLimit: vi.fn(() => (req, res, next) => next()), // just in case
}));

describe("Deployment Fix Verification", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should allow CORS for the deployed Vercel frontend", async () => {
    const res = await request(app)
      .options("/api/health")
      .set("Origin", "https://googledrive-frontend-seven.vercel.app");

    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://googledrive-frontend-seven.vercel.app",
    );
  });

  it("should generate reset link using request origin if FRONTEND_URL is missing", async () => {
    // Setup mock user
    const mockUser = {
      _id: "user_123",
      email: "test@example.com",
      username: "testuser",
    };
    User.findOne.mockResolvedValue(mockUser);
    PasswordResetToken.create.mockResolvedValue({});

    // Spy on email service
    const sendEmailSpy = vi.spyOn(emailService, "sendPasswordResetEmail");
    sendEmailSpy.mockResolvedValue();

    // Ensure FRONTEND_URL is undefined
    delete process.env.FRONTEND_URL;
    process.env.JWT_SECRET = "test-secret";

    const origin = "https://googledrive-frontend-seven.vercel.app";

    await request(app)
      .post("/api/auth/forgot-password")
      .set("Origin", origin)
      .send({ email: "test@example.com" })
      .expect(204);

    expect(sendEmailSpy).toHaveBeenCalled();
    const callArgs = sendEmailSpy.mock.calls[0];
    const resetLink = callArgs[2];

    console.log("Generated Link:", resetLink);
    expect(resetLink).toContain(origin);
  });
});
