import { vi, describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../app.js";
import { cleanupTrash } from "../services/cronService.js";
import { softDeleteFile } from "../services/fileService.js";

// Mock dependencies
vi.mock("multer-s3", () => ({
  default: vi.fn().mockReturnValue({
    _handleFile: (req, file, cb) => {
      file.key = "mock/key";
      cb(null, { key: "mock/key", location: "mock-location" });
    },
    _removeFile: (req, file, cb) => cb(null),
  }),
}));

vi.mock("../middleware/auth.js", () => ({
  protect: (req, res, next) => {
    req.user = { id: "user_id" };
    next();
  },
}));

vi.mock("../services/s3Service.js", () => ({
  deleteFromS3: vi.fn().mockResolvedValue(true),
  getS3Key: vi.fn().mockReturnValue("mock/key"),
  checkS3Connection: vi.fn().mockResolvedValue(true),
  s3Client: { send: vi.fn() },
}));

// Mock Mongoose Models
const mockSave = vi.fn();
const mockFileObj = {
  _id: "file_id",
  name: "test.txt",
  size: 1024,
  mimeType: "text/plain",
  userId: "test_user_id",
  parentId: null,
  isStarred: false,
  isTrash: false,
  s3Key: "test/key",
  type: "file",
  createdAt: new Date(),
  updatedAt: new Date(),
  save: mockSave,
};

const mockUserObj = {
  _id: "test_user_id",
  email: "test@example.com",
  trashRetentionDays: 30,
  isActive: true,
};

vi.mock("../models/File.js", () => {
  return {
    default: {
      find: vi.fn(),
      findOne: vi.fn(),
      findById: vi.fn(),
      exists: vi.fn(),
      deleteOne: vi.fn(),
      deleteMany: vi.fn(),
      create: vi.fn(),
    },
  };
});

vi.mock("../models/User.js", () => {
  return {
    default: {
      find: vi.fn(),
      findById: vi.fn(),
      save: vi.fn(),
    },
  };
});

import File from "../models/File.js";
import User from "../models/User.js";

describe("Delete Workflow & Trash Management", () => {
  beforeEach(() => {
    vi.resetAllMocks(); // Resets implementations too

    // Setup default mocks
    File.find.mockResolvedValue([]);
    File.findOne.mockResolvedValue(null);
    File.findById.mockResolvedValue(null);
    File.exists.mockResolvedValue(false);
    File.deleteOne.mockResolvedValue({ deletedCount: 1 });
    User.find.mockResolvedValue([]);
  });

  describe("Permanent Delete (DELETE /api/files/:id)", () => {
    it("should permanently delete a file", async () => {
      const fileInstance = { ...mockFileObj, isTrash: true };
      File.findOne.mockResolvedValue(fileInstance);
      File.find.mockResolvedValue([]); // No children
      File.deleteOne.mockResolvedValue({ deletedCount: 1 });

      const res = await request(app).delete("/api/files/file_id");

      expect(res.statusCode).toBe(200);
      expect(res.body.message).toMatch(/permanently deleted/i);
      expect(File.deleteOne).toHaveBeenCalledWith({ _id: "file_id" });
    });

    it("should return 404 if file not found", async () => {
      File.findOne.mockResolvedValue(null);
      const res = await request(app).delete("/api/files/non_existent");
      expect(res.statusCode).toBe(404);
    });
  });

  describe("Restore (POST /api/files/restore/:id)", () => {
    it("should restore a file", async () => {
      const fileInstance = {
        ...mockFileObj,
        isTrash: true,
        trashedAt: new Date(),
        save: vi.fn(),
      };
      File.findOne.mockResolvedValue(fileInstance);
      File.find.mockResolvedValue([]); // No children

      const res = await request(app).post("/api/files/restore/file_id");

      expect(res.statusCode).toBe(200);
      expect(fileInstance.isTrash).toBe(false);
      expect(fileInstance.trashedAt).toBeNull();
      expect(fileInstance.save).toHaveBeenCalled();
    });
  });

  describe("Permanent Delete (DELETE /api/files/permanent/:id)", () => {
    it("should permanently delete a file", async () => {
      const fileInstance = { ...mockFileObj, isTrash: true };
      File.findOne.mockResolvedValue(fileInstance);
      File.find.mockResolvedValue([]); // No children
      File.deleteOne.mockResolvedValue({ deletedCount: 1 });

      const res = await request(app).delete("/api/files/permanent/file_id");

      expect(res.statusCode).toBe(200);
      expect(res.body.message).toMatch(/permanently deleted/i);
      expect(File.deleteOne).toHaveBeenCalledWith({ _id: "file_id" });
    });
  });

  describe("Bulk Delete (POST /api/files/bulk-delete)", () => {
    it("should soft delete multiple files", async () => {
      const file1 = {
        ...mockFileObj,
        _id: "f1",
        isTrash: false,
        save: vi.fn(),
      };
      const file2 = {
        ...mockFileObj,
        _id: "f2",
        isTrash: false,
        save: vi.fn(),
      };

      // Mock findOne for each call inside softDeleteFile
      File.findOne.mockResolvedValueOnce(file1).mockResolvedValueOnce(file2);

      File.find.mockResolvedValue([]); // No children

      const res = await request(app)
        .post("/api/files/bulk-delete")
        .send({ ids: ["f1", "f2"] });

      expect(res.statusCode).toBe(200);
      expect(file1.isTrash).toBe(true);
      expect(file2.isTrash).toBe(true);
    });
  });

  describe("Empty Trash (DELETE /api/files/trash/empty)", () => {
    it("should delete all trashed files", async () => {
      const fileInstance = { ...mockFileObj, isTrash: true };

      // First finding all trash
      File.find.mockResolvedValue([fileInstance]);

      // Inside deleteFilePermanently loop
      File.findOne.mockResolvedValue(fileInstance);
      File.deleteOne.mockResolvedValue({ deletedCount: 1 });

      const res = await request(app).delete("/api/files/trash/empty");

      expect(res.statusCode).toBe(200);
      // We expect deleteOne to be called
      expect(File.deleteOne).toHaveBeenCalled();
    });
  });

  describe("Automatic Purge (Cron Job)", () => {
    it("should permanently delete expired files", async () => {
      User.find.mockResolvedValue([mockUserObj]);

      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 31); // 31 days old > 30 days retention

      const expiredFile = {
        ...mockFileObj,
        _id: "expired_id",
        isTrash: true,
        trashedAt: oldDate,
      };

      // Mock finding expired files
      File.find.mockResolvedValueOnce([expiredFile]); // for expiredFiles query

      // Mock File.exists check
      File.exists.mockResolvedValue(true);

      // Mock deleteFilePermanently calls
      File.findOne.mockResolvedValue(expiredFile);
      File.deleteOne.mockResolvedValue({ deletedCount: 1 });

      // Also need to handle inner calls of deleteFilePermanently which calls File.find (for children)
      // We can mock File.find to return empty array for the second call
      File.find.mockResolvedValue([]);

      // To make this work with multiple calls to File.find:
      // 1. User.find -> [user]
      // 2. File.find (expired) -> [expiredFile]
      // 3. Loop -> File.exists -> true
      // 4. deleteFilePermanently -> File.findOne -> expiredFile
      // 5. deleteFilePermanently -> File.find (children) -> []
      // 6. deleteFromS3
      // 7. File.deleteOne

      // We need to carefully sequence mocks or use mockImplementation
      File.find
        .mockResolvedValueOnce([expiredFile]) // Cron query
        .mockResolvedValueOnce([]); // Children query inside deleteFilePermanently

      const deletedCount = await cleanupTrash();

      expect(deletedCount).toBe(1);
      expect(File.deleteOne).toHaveBeenCalledWith({ _id: "expired_id" });
    });
  });
});
