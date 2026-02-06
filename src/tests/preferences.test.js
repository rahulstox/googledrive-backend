import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// Set env vars
process.env.S3_BUCKET_NAME = "test-bucket";
process.env.JWT_SECRET = "test-secret";

// Mock middleware
const mockUser = {
  _id: "user123",
  email: "test@test.com",
  role: "user",
  preferences: {
    notifications: { email: true, push: true },
    privacy: { profileVisibility: "public" },
    language: "en",
  },
  save: vi.fn(),
  toObject: vi.fn().mockReturnValue({}),
};

vi.mock("../middleware/auth.js", () => ({
  protect: (req, res, next) => {
    req.user = mockUser;
    next();
  },
  authenticate: (req, res, next) => {
    req.user = mockUser;
    next();
  },
  authorize: () => (req, res, next) => next(),
}));

vi.mock("multer-s3", () => ({
  default: vi.fn(() => ({
    _handleFile: (req, file, cb) => cb(null, {}),
    _removeFile: (req, file, cb) => cb(null),
  })),
}));

vi.mock("../models/User.js");
vi.mock("../services/cacheService.js", () => ({
  cache: {
    del: vi.fn(),
    set: vi.fn(),
  },
}));

vi.mock("../services/emailService.js", () => ({
  sendActivationEmail: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  sendPasswordChangedEmail: vi.fn(),
  sendAccountDeletionEmail: vi.fn(),
}));

// Set env vars
process.env.JWT_SECRET = "test-secret";

// Import app after mocks
import { app } from "../app.js";
import User from "../models/User.js";

describe("Preferences Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mockUser state
    mockUser.preferences = {
      notifications: { email: true, push: true },
      privacy: { profileVisibility: "public" },
      language: "en",
    };
    mockUser.save.mockResolvedValue(true);
    User.exists = vi.fn().mockResolvedValue(false);
  });

  it("PUT /api/auth/me should update preferences deeply", async () => {
    const newPrefs = {
      notifications: { email: false }, // Should update email but keep push
      privacy: { showActivityStatus: false }, // Should add/update this
      language: "es", // Should update this
    };

    const res = await request(app)
      .put("/api/auth/me")
      .send({ preferences: newPrefs });

    expect(res.status).toBe(200);

    // Check that user.preferences was updated correctly
    expect(mockUser.preferences.notifications.email).toBe(false);
    expect(mockUser.preferences.notifications.push).toBe(true); // Should be preserved
    expect(mockUser.preferences.language).toBe("es");
    expect(mockUser.preferences.privacy.showActivityStatus).toBe(false);
    expect(mockUser.preferences.privacy.profileVisibility).toBe("public"); // Preserved

    expect(mockUser.save).toHaveBeenCalled();
  });
});
