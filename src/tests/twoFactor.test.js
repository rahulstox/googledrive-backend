import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import User from "../models/User.js";
import speakeasy from "speakeasy";

// Set necessary env vars before importing app
process.env.S3_BUCKET_NAME = "test-bucket";
process.env.JWT_SECRET = "test-secret-very-long-to-be-secure";
process.env.BREVO_API_KEY = "test-key";

// Mock dependencies
vi.mock("../middleware/auth.js", () => ({
  protect: (req, res, next) => {
    req.user = { id: "user123", email: "user@test.com", save: vi.fn() };
    next();
  },
  authenticate: (req, res, next) => {
    req.user = { id: "user123", email: "user@test.com", save: vi.fn() };
    next();
  },
  authorize: (...roles) => {
    return (req, res, next) => {
      if (!req.user.role || !roles.includes(req.user.role)) {
        return res.status(403).json({ message: "Forbidden" });
      }
      next();
    };
  },
}));

vi.mock("../models/User.js");
vi.mock("speakeasy");
vi.mock("multer-s3", () => ({
  default: vi.fn(() => ({
    _handleFile: (req, file, cb) =>
      cb(null, { location: "mock-location", key: "mock-key" }),
    _removeFile: (req, file, cb) => cb(null),
  })),
}));
vi.mock("qrcode", () => ({
  default: {
    toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,mockqrcode"),
  },
}));

// Mock s3Service to prevent multer-s3 issues if possible, though setting env var might be enough
// if multer-s3 is just checking for bucket name string.
// However, fileRoutes imports s3Client from s3Service.
vi.mock("../services/s3Service.js", () => ({
  s3Client: {}, // Empty object might be enough for import, but multerS3 might need it.
  deleteFromS3: vi.fn(),
}));

import { app } from "../app.js";

describe("2FA Endpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("POST /api/auth/2fa/generate should return secret and qrCode", async () => {
    speakeasy.generateSecret.mockReturnValue({
      base32: "MOCKSECRET",
      otpauth_url: "otpauth://mock",
    });

    const mockSave = vi.fn();
    // Middleware mock sets req.user, but we need to ensure User.findById (if used) also works
    // However, the generate endpoint uses req.user directly from middleware if available.
    // Let's check route implementation:
    // router.post("/2fa/generate", protect, async (req, res) => { ... req.user.twoFactorSecret = ... })
    // So mocking protect middleware to populate req.user is enough.

    const res = await request(app).post("/api/auth/2fa/generate");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("secret", "MOCKSECRET");
    expect(res.body).toHaveProperty("qrCode");
  });

  it("POST /api/auth/2fa/verify should enable 2FA on success", async () => {
    User.findById.mockReturnValue({
      select: vi.fn().mockResolvedValue({
        twoFactorSecret: "MOCKSECRET",
        save: vi.fn(),
      }),
    });

    speakeasy.totp.verify.mockReturnValue(true);

    const res = await request(app)
      .post("/api/auth/2fa/verify")
      .send({ token: "123456" });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/enabled successfully/);
  });

  it("POST /api/auth/2fa/verify should fail with invalid token", async () => {
    User.findById.mockReturnValue({
      select: vi.fn().mockResolvedValue({
        twoFactorSecret: "MOCKSECRET",
        save: vi.fn(),
      }),
    });

    speakeasy.totp.verify.mockReturnValue(false);

    const res = await request(app)
      .post("/api/auth/2fa/verify")
      .send({ token: "000000" });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Invalid 2FA code/);
  });

  it("POST /api/auth/2fa/disable should disable 2FA with correct password", async () => {
    const mockUser = {
      comparePassword: vi.fn().mockResolvedValue(true),
      save: vi.fn(),
      twoFactorEnabled: true,
      twoFactorSecret: "SECRET",
    };

    User.findById.mockReturnValue({
      select: vi.fn().mockResolvedValue(mockUser),
    });

    const res = await request(app)
      .post("/api/auth/2fa/disable")
      .send({ password: "password123" });

    expect(res.status).toBe(200);
    expect(mockUser.twoFactorEnabled).toBe(false);
    expect(mockUser.twoFactorSecret).toBeUndefined();
  });
});
