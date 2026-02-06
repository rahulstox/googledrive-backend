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

describe("Activation Cache Invalidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = "test-secret";
    process.env.FRONTEND_URL = "http://localhost:5173";
  });

  it("should invalidate cache and set active user on activation", async () => {
    const mockUser = {
      _id: "user123",
      email: "test@example.com",
      isActive: false,
      activationToken: "valid-token",
      activationTokenExpires: new Date(Date.now() + 3600000), // 1 hour future
      save: vi.fn(),
      getSignedJwtToken: vi.fn().mockReturnValue("valid-token"),
      toObject: function() { 
        // Return a plain object representation
        return { 
          _id: this._id,
          email: this.email,
          isActive: this.isActive 
        }; 
      }
    };

    // Mock User.findOne to return our mock user
    User.findOne = vi.fn().mockImplementation(() => ({
      select: vi.fn().mockResolvedValue(mockUser)
    }));

    // Create a valid JWT for the activation link
    const token = jwt.sign({ email: "test@example.com" }, "test-secret");
    
    // Act
    const res = await request(app).get(`/api/auth/activate?token=${token}`);

    // Assert
    expect(res.status).toBe(200);
    expect(mockUser.isActive).toBe(true);
    expect(mockUser.activationToken).toBeUndefined();
    
    // Verify Cache Invalidation was called with correct key
    expect(cache.del).toHaveBeenCalledWith("user:user123");
    
    // Verify Cache Update (The Proactive Fix) was called
    // It should store the user with isActive: true
    expect(cache.set).toHaveBeenCalledWith(
      "user:user123", 
      expect.stringContaining('"isActive":true')
    );
  });

  it("should return 400 if token is invalid", async () => {
    const res = await request(app).get("/api/auth/activate?token=invalid-token");
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("Invalid");
  });
});
