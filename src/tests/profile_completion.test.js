import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Mock Resend to avoid "Missing API key" error
vi.mock("resend", () => {
  return {
    Resend: vi.fn(function () {
      this.emails = {
        send: vi
          .fn()
          .mockResolvedValue({ data: { id: "mock_id" }, error: null }),
      };
    }),
  };
});

// Mock multer-s3 before importing app
vi.mock("multer-s3", () => {
  return {
    default: () => ({
      _handleFile: (req, file, cb) =>
        cb(null, { location: "mock-url", key: "mock-key" }),
      _removeFile: (req, file, cb) => cb(null),
    }),
  };
});

// Mock emailService to prevent actual sending attempt
vi.mock("../services/emailService.js", () => ({
  sendActivationEmail: vi.fn().mockResolvedValue(true),
  sendEmail: vi.fn().mockResolvedValue(true),
}));

import dotenv from "dotenv";
dotenv.config();

import request from "supertest";
import mongoose from "mongoose";
import { app } from "../app.js";
import User from "../models/User.js";
import { connectDB } from "../config/db.js";

describe("Profile Completion Flow", () => {
  let token;
  const testEmail = "profile.test@example.com";
  const testPassword = "Password123!";

  beforeAll(async () => {
    await connectDB();
    await User.deleteMany({ email: { $in: [testEmail, "other@example.com"] } });
  });

  afterAll(async () => {
    await User.deleteMany({ email: { $in: [testEmail, "other@example.com"] } });
    await mongoose.connection.close();
  });

  it("should register a user with username", async () => {
    const res = await request(app).post("/api/auth/register").send({
      email: testEmail,
      password: testPassword,
      username: "testuser",
    });

    expect(res.status).toBe(201);

    const user = await User.findOne({ email: testEmail });
    expect(user).toBeDefined();
    expect(user.username).toBe("testuser");
    expect(user.isActive).toBe(false);

    // Manually activate for next tests
    user.isActive = true;
    await user.save();
  }, 15000);

  it("should login and receive token", async () => {
    const res = await request(app).post("/api/auth/login").send({
      email: testEmail,
      password: testPassword,
    });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    token = res.body.token;

    // Check returned user object
    expect(res.body.user.username).toBe("testuser");
  });

  it("should update profile username via PUT /me", async () => {
    const res = await request(app)
      .put("/api/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .send({
        username: "newusername",
      });

    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe("newusername");

    // Verify in DB
    const user = await User.findOne({ email: testEmail });
    expect(user.username).toBe("newusername");
  });

  it("should fail validation for invalid username", async () => {
    const res = await request(app)
      .put("/api/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .send({
        username: "ab", // Too short
      });

    expect(res.status).toBe(400);
    expect(res.body.errors).toBeDefined();
  });

  it("should fail for duplicate username", async () => {
    // Create another user
    await User.create({
      email: "other@example.com",
      password: "Password123!",
      username: "taken_user",
      isActive: true,
    });

    const res = await request(app)
      .put("/api/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .send({
        username: "taken_user",
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/taken/i);

    // Cleanup
    await User.deleteOne({ email: "other@example.com" });
  });
});
