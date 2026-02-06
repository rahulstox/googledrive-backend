import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock environment variables BEFORE imports
process.env.S3_BUCKET_NAME = "test-bucket";

// Mock Resend to avoid "Missing API key" error
vi.mock("resend", () => {
  return {
    Resend: vi.fn(function () {
      this.emails = { send: vi.fn() };
    }),
  };
});

// Mock multer-s3 to avoid bucket error
vi.mock("multer-s3", () => {
  return {
    default: () => ({
      _handleFile: (req, file, cb) => cb(null, { location: "mock-url" }),
      _removeFile: (req, file, cb) => cb(null),
    }),
  };
});

import request from "supertest";
import { app } from "../app.js";
import User from "../models/User.js";
import { cache } from "../services/cacheService.js";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";

describe("Activation Bug Reproduction", () => {
  const mockUser = {
    _id: new mongoose.Types.ObjectId(),
    email: "bugcheck@example.com",
    password: "hashedpassword",
    username: "bugcheck",
    isActive: false, // Start inactive
    activationToken: "valid-token",
    activationTokenExpires: new Date(Date.now() + 3600000),
    loginHistory: [],
    comparePassword: vi.fn().mockResolvedValue(true),
    getSignedJwtToken: vi.fn().mockReturnValue("valid-jwt-token"),
    toObject: function () {
      return {
        _id: this._id,
        email: this.email,
        username: this.username,
        isActive: this.isActive,
        authProvider: "email",
      };
    },
  };

  const validToken = jwt.sign(
    { id: mockUser._id },
    process.env.JWT_SECRET || "secret",
  );

  beforeEach(async () => {
    process.env.S3_BUCKET_NAME = "test-bucket"; // Fix Multer error
    process.env.JWT_SECRET = "secret"; // Ensure secret matches
    vi.clearAllMocks();
    // Mock User.findOne to return our mock user
    User.findOne = vi.fn().mockImplementation(() => ({
      select: vi.fn().mockImplementation((fields) => {
        // Simulate selecting fields. isActive should be there by default unless excluded.
        return {
          ...mockUser,
          isActive: mockUser.isActive,
        };
      }),
    }));

    // Mock User.findById for authenticate middleware
    User.findById = vi.fn().mockImplementation(() => ({
      select: vi.fn().mockReturnValue({
        ...mockUser,
        isActive: mockUser.isActive,
      }),
    }));

    // Mock User.create
    User.create = vi.fn().mockResolvedValue(mockUser);

    // Mock save
    mockUser.save = vi.fn().mockImplementation(function () {
      this.isActive = true; // Simulate activation
      return Promise.resolve(this);
    });

    // Mock cache
    cache.get = vi.fn().mockResolvedValue(null);
    cache.set = vi.fn().mockResolvedValue("OK");
    cache.del = vi.fn().mockResolvedValue(1);
  });

  it("should fail login if user is inactive", async () => {
    mockUser.isActive = false;
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "bugcheck@example.com", password: "password" });

    expect(res.status).toBe(403);
    expect(res.body.message).toBe(
      "Account not activated. Please check your email.",
    );
  });

  it("should allow login if user is active", async () => {
    mockUser.isActive = true;
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "bugcheck@example.com", password: "password" });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();

    // Verify cache was set
    expect(cache.set).toHaveBeenCalled();
    const cachedData = JSON.parse(cache.set.mock.calls[0][1]);
    expect(cachedData.isActive).toBe(true);
  });

  it("should access protected route after activation and login", async () => {
    // 1. Simulate Activation
    // Manually update mock to active as if /activate was called
    mockUser.isActive = true;

    // 2. Simulate Login (Populates Cache)
    // We assume login called cache.set with active user
    const userForCache = mockUser.toObject();
    userForCache.isActive = true;
    cache.get.mockResolvedValue(JSON.stringify(userForCache));

    // 3. Access Protected Route
    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${validToken}`);

    expect(res.status).toBe(200);
    expect(res.body.user.isActive).toBe(true);
  });

  it("should recover from stale inactive cache", async () => {
    // Scenario:
    // Cache says inactive (stale), but DB says active.

    // Setup stale cache
    const staleUser = { ...mockUser.toObject(), isActive: false };
    cache.get.mockResolvedValue(JSON.stringify(staleUser));

    // Setup DB to return ACTIVE user
    mockUser.isActive = true;

    // Try to access protected route with valid token
    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${validToken}`);

    // This should PASS now because we force DB fetch if cache says inactive
    expect(res.status).toBe(200);
    expect(res.body.user.isActive).toBe(true);

    // Verify that we fetched from DB and updated cache
    expect(User.findById).toHaveBeenCalled();
    expect(cache.set).toHaveBeenCalled();
  });
});
