import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

// Mock middleware
const mockUser = { role: "user" };
vi.mock("multer-s3", () => ({
  default: vi.fn(() => ({
    _handleFile: (req, file, cb) =>
      cb(null, { location: "mock-location", key: "mock-key" }),
    _removeFile: (req, file, cb) => cb(null),
  })),
}));

vi.mock("../middleware/auth.js", () => ({
  protect: (req, res, next) => {
    req.user = mockUser;
    next();
  },
  authenticate: (req, res, next) => {
    req.user = mockUser;
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

// Set necessary env vars before importing app
process.env.S3_BUCKET_NAME = "test-bucket";
process.env.JWT_SECRET = "test-secret-very-long-to-be-secure";
process.env.BREVO_API_KEY = "test-key";

import { app } from "../app.js";
import User from "../models/User.js";
import File from "../models/File.js";

vi.mock("../models/User.js");
vi.mock("../models/File.js");

describe("Admin Settings Routes", () => {
  beforeEach(() => {
    mockUser.role = "user"; // Default to user
    vi.clearAllMocks();

    // Default mock implementations
    User.countDocuments = vi.fn().mockResolvedValue(10);
    User.aggregate = vi.fn().mockImplementation((pipeline) => {
      // Check if it's the stats query (starts with $group)
      if (pipeline[0] && pipeline[0].$group) {
        return Promise.resolve([
          { totalUsers: 10, activeUsers: 8, totalStorage: 5000 },
        ]);
      }
      // Check if it's the audit query (starts with $match)
      if (pipeline[0] && pipeline[0].$match) {
        return Promise.resolve([
          {
            user: "test@test.com",
            action: "Login",
            ip: "127.0.0.1",
            timestamp: new Date().toISOString(),
            details: "Test Device",
          },
        ]);
      }
      return Promise.resolve([]);
    });
    User.find = vi.fn().mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([
          {
            email: "test@test.com",
            loginHistory: [
              {
                ip: "127.0.0.1",
                timestamp: new Date(),
                device: "Test Device",
              },
            ],
          },
        ]),
      }),
    });
    File.countDocuments = vi.fn().mockResolvedValue(50);
  });

  it("GET /api/settings/public-config should be accessible to anyone", async () => {
    const res = await request(app).get("/api/settings/public-config");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("appName");
  });

  it("GET /api/settings/admin/audit should return 403 for normal user", async () => {
    mockUser.role = "user";
    const res = await request(app).get("/api/settings/admin/audit");
    expect(res.status).toBe(403);
  });

  it("GET /api/settings/admin/audit should return 200 for admin", async () => {
    mockUser.role = "admin";
    const res = await request(app).get("/api/settings/admin/audit");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("logs");
    expect(Array.isArray(res.body.logs)).toBe(true);
  });

  it("GET /api/settings/admin/stats should return stats for admin", async () => {
    mockUser.role = "admin";
    const res = await request(app).get("/api/settings/admin/stats");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("totalUsers", 10);
    expect(res.body).toHaveProperty("totalStorageUsed", 5000);
    expect(res.body).toHaveProperty("totalFiles", 50);
  });
});
