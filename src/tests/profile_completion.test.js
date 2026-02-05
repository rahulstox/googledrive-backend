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
    await User.deleteMany({ email: testEmail });
  });

  afterAll(async () => {
    await User.deleteMany({ email: testEmail });
    await mongoose.connection.close();
  });

  it("should register a user without names (defaults used)", async () => {
    const res = await request(app).post("/api/auth/register").send({
      email: testEmail,
      password: testPassword,
    });

    expect(res.status).toBe(201);

    const user = await User.findOne({ email: testEmail });
    expect(user).toBeDefined();
    expect(user.firstName).toBe("User");
    expect(user.lastName).toBe("");
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
    expect(res.body.user.firstName).toBe("User");
    expect(res.body.user.lastName).toBe("");
  });

  it("should update profile names via PUT /me", async () => {
    const res = await request(app)
      .put("/api/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .send({
        firstName: "John",
        lastName: "Doe",
      });

    expect(res.status).toBe(200);
    expect(res.body.user.firstName).toBe("John");
    expect(res.body.user.lastName).toBe("Doe");

    // Verify in DB
    const user = await User.findOne({ email: testEmail });
    expect(user.firstName).toBe("John");
    expect(user.lastName).toBe("Doe");
  });
});
