
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { app } from "../app.js";
import User from "../models/User.js";
import { connectDB } from "../config/db.js";
import dotenv from "dotenv";

dotenv.config();

// Mock S3/Multer to prevent errors
vi.mock("multer-s3", () => {
  return {
    default: () => ({
      _handleFile: (req, file, cb) => cb(null, { location: "mock-url", key: "mock-key" }),
      _removeFile: (req, file, cb) => cb(null),
    }),
  };
});

describe("Login Diagnostics", () => {
  const activeUser = {
    email: "active.login@test.com",
    password: "Password123!",
    firstName: "Active",
    lastName: "User",
    isActive: true,
  };

  const inactiveUser = {
    email: "inactive.login@test.com",
    password: "Password123!",
    firstName: "Inactive",
    lastName: "User",
    isActive: false,
  };

  beforeAll(async () => {
    await connectDB();
    await User.deleteMany({ email: { $in: [activeUser.email, inactiveUser.email] } });
    
    // Create users
    await User.create(activeUser);
    await User.create(inactiveUser);
  });

  afterAll(async () => {
    await User.deleteMany({ email: { $in: [activeUser.email, inactiveUser.email] } });
    await mongoose.connection.close();
  });

  it("should successfully login with valid credentials", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({
        email: activeUser.email,
        password: activeUser.password,
      });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user).toBeDefined();
    expect(res.body.user.email).toBe(activeUser.email);
    expect(res.body.user.firstName).toBe(activeUser.firstName);
    // Ensure no sensitive data
    expect(res.body.user.password).toBeUndefined();
  });

  it("should fail with 401 for incorrect password", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({
        email: activeUser.email,
        password: "WrongPassword!",
      });

    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/Invalid email or password/i);
  });

  it("should fail with 401 for non-existent email", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({
        email: "nonexistent@test.com",
        password: "Password123!",
      });

    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/Invalid email or password/i);
  });

  it("should fail with 403 for inactive user", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({
        email: inactiveUser.email,
        password: inactiveUser.password,
      });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/Account not activated/i);
  });

  it("should fail with 400 for missing email", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({
        password: "Password123!",
      });

    expect(res.status).toBe(400);
  });

  it("should fail with 400 for missing password", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({
        email: activeUser.email,
      });

    expect(res.status).toBe(400);
  });
});
