import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { app } from "../app.js";
import AdmZip from "adm-zip";
import File from "../models/File.js";
import User from "../models/User.js";
import fs from "fs";
import path from "path";
import os from "os";

// Hoisted mocks to allow modification in tests
const mocks = vi.hoisted(() => ({
  user: {
    id: "test_user_id",
    storageUsed: 0,
    storageLimit: 1000000, // 1MB
  },
}));

// Mock dependencies
vi.mock("../services/s3Service.js", () => ({
  uploadToS3: vi.fn().mockResolvedValue("mock-s3-key"),
  getS3Key: vi.fn().mockReturnValue("mock/key"),
  s3Client: { send: vi.fn() },
}));

vi.mock("multer-s3", () => ({
  default: vi.fn().mockReturnValue({
    _handleFile: vi.fn(),
    _removeFile: vi.fn(),
  }),
  AUTO_CONTENT_TYPE: "auto",
}));

vi.mock("../middleware/auth.js", () => ({
  protect: (req, res, next) => {
    req.user = mocks.user;
    next();
  },
  authenticate: (req, res, next) => {
    req.user = mocks.user;
    next();
  },
}));

vi.mock("../models/File.js", () => ({
  default: {
    findOne: vi.fn(),
    create: vi.fn(),
    find: vi.fn(),
    findByIdAndUpdate: vi.fn(),
    deleteOne: vi.fn(),
    exists: vi.fn(),
  },
}));

vi.mock("../models/User.js", () => ({
  default: {
    findById: vi.fn(),
    findByIdAndUpdate: vi.fn(),
  },
}));

describe("Zip Upload & Storage", () => {
  let zipBuffer;
  const tempZipPath = path.join(os.tmpdir(), "test-upload.zip");

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset user mock
    mocks.user.storageUsed = 0;
    mocks.user.storageLimit = 1000000;

    // Create a valid zip file
    const zip = new AdmZip();
    zip.addFile("test.txt", Buffer.from("Hello World"));
    zip.addFile("folder/inner.txt", Buffer.from("Inner file"));
    zipBuffer = zip.toBuffer();
    fs.writeFileSync(tempZipPath, zipBuffer);
  });

  afterEach(() => {
    if (fs.existsSync(tempZipPath)) {
      fs.unlinkSync(tempZipPath);
    }
  });

  describe("GET /api/files/storage", () => {
    it("should return storage usage", async () => {
      User.findById.mockReturnValue({
        select: vi.fn().mockResolvedValue({
          storageUsed: 500,
          storageLimit: 1000,
        }),
      });

      const res = await request(app).get("/api/files/storage");
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        used: 500,
        limit: 1000,
        percent: 50,
      });
    });
  });

  describe("POST /api/files/upload-zip", () => {
    it("should upload and extract zip file", async () => {
      // Mock File.findOne to return null (folder doesn't exist)
      File.findOne.mockResolvedValue(null);
      // Mock File.create
      File.create.mockImplementation((data) =>
        Promise.resolve({ ...data, _id: "new_id" }),
      );

      const res = await request(app)
        .post("/api/files/upload-zip")
        .attach("file", tempZipPath);

      expect(res.statusCode).toBe(201);
      expect(res.body.message).toBe("Zip extracted successfully.");
      expect(File.create).toHaveBeenCalled();
      // Expect 2 files + 1 folder (folder/inner.txt implies 'folder' dir)
      // Actually 'folder/' is implicit in 'folder/inner.txt' entry if not explicitly added as directory?
      // AdmZip.addFile doesn't add directory entry unless addLocalFolder is used or addFile with slash?
      // But ensurePath handles it.

      // User storage should be updated
      expect(User.findByIdAndUpdate).toHaveBeenCalledWith(
        "test_user_id",
        expect.objectContaining({ $inc: { storageUsed: expect.any(Number) } }),
      );
    });

    it("should reject if quota exceeded", async () => {
      // Set storage used to near limit
      mocks.user.storageUsed = 999999;
      // The zip file is small but > 1 byte, so it should fail

      try {
        const res = await request(app)
          .post("/api/files/upload-zip")
          .attach("file", tempZipPath);

        expect(res.statusCode).toBe(403);
        expect(res.body.message).toMatch(/quota exceeded/i);
        expect(File.create).not.toHaveBeenCalled();
      } catch (err) {
        if (err.code === "ECONNRESET") {
          // Expected behavior when server closes connection on quota exceeded during upload
          expect(File.create).not.toHaveBeenCalled();
        } else {
          throw err;
        }
      }
    });
  });
});
