import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import User from "../models/User.js";

// Mock dependencies
vi.mock("../models/User.js");
vi.mock("../services/s3Service.js", () => ({
  checkS3Connection: vi.fn().mockResolvedValue(true),
  s3Client: {},
}));

describe("Settings Routes", () => {
  let app;

  beforeEach(async () => {
    vi.resetModules(); // Reset cache to ensure fresh import
    process.env.S3_BUCKET_NAME = "test-bucket";
    process.env.JWT_SECRET = "test-secret-at-least-32-chars-long-for-security";
    process.env.FRONTEND_URL = "http://localhost:3000";

    // Dynamic import to handle env vars
    const module = await import("../app.js");
    app = module.app;
  });

  it("GET /api/settings/public-config should return config object", async () => {
    const res = await request(app).get("/api/settings/public-config");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("allowRegistration");
    expect(res.body).toHaveProperty("enable2FA");
    expect(res.body).toHaveProperty("appName", "Krypton Drive");
  });
});
