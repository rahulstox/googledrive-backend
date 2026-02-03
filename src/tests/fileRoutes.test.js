import { vi, describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../app.js";
import { PassThrough } from "stream";
import File from "../models/File.js";

// Mock dependencies
vi.mock("multer-s3", () => ({
  default: vi.fn().mockReturnValue({
    _handleFile: (req, file, cb) => {
      // Consume the stream to avoid hanging
      file.stream.resume();
      file.key = "mock/key";
      cb(null, {
        size: 1024,
        bucket: "test-bucket",
        key: "mock/key",
        acl: "private",
        contentType: file.mimetype,
        location: "http://s3.com/mock/key",
        etag: "mock-etag",
      });
    },
    _removeFile: (req, file, cb) => cb(null),
  }),
}));

vi.mock("../middleware/auth.js", () => ({
  protect: (req, res, next) => {
    req.user = { id: "test_user_id" };
    next();
  },
}));

vi.mock("../services/s3Service.js", () => ({
  s3Client: { send: vi.fn() },
  getS3Key: vi.fn().mockReturnValue("mock/key"),
  uploadToS3: vi
    .fn()
    .mockResolvedValue({ Location: "http://s3.com/file", Key: "file_key" }),
  deleteFromS3: vi.fn().mockResolvedValue(true),
  getPresignedDownloadUrl: vi.fn().mockResolvedValue("http://signed-url.com"),
  getObjectStream: vi.fn().mockImplementation(() => {
    const stream = new PassThrough();
    stream.end("mock content");
    return {
      body: stream,
      contentType: "text/plain",
      contentLength: 12,
      acceptRanges: "bytes",
    };
  }),
  copyInS3: vi.fn().mockResolvedValue(true),
  checkS3Connection: vi.fn().mockResolvedValue(true),
}));

// Mock Mongoose Model
vi.mock("../models/File.js", () => {
  const mockFile = {
    _id: "file_id",
    name: "test.txt",
    size: 1024,
    mimeType: "text/plain",
    type: "file",
    userId: "test_user_id",
    parentId: null,
    isStarred: false,
    isTrash: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    save: vi.fn(),
  };

  const save = vi.fn().mockResolvedValue(true);
  const MockFile = vi.fn().mockImplementation(() => ({
    save,
    ...mockFile,
  }));

  // Static methods
  MockFile.find = vi.fn().mockReturnThis();
  MockFile.findOne = vi.fn();
  MockFile.findById = vi.fn();
  MockFile.create = vi.fn().mockImplementation((data) => {
    return Promise.resolve({
      ...mockFile,
      ...data,
      save: vi.fn().mockResolvedValue(true),
    });
  });
  MockFile.sort = vi.fn().mockReturnThis();
  MockFile.lean = vi.fn().mockReturnThis();

  return { default: MockFile };
});

const mockFile = {
  _id: "file_id",
  name: "test.txt",
  size: 1024,
  mimeType: "text/plain",
  type: "file",
  userId: "test_user_id",
  parentId: null,
  isStarred: false,
  isTrash: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  save: vi.fn(),
};

describe("File Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/files", () => {
    it("should return a list of files", async () => {
      File.find.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([mockFile]),
        }),
      });

      const res = await request(app).get("/api/files");
      expect(res.statusCode).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].name).toBe("test.txt");
      expect(File.find).toHaveBeenCalledWith(
        expect.objectContaining({ isTrash: false }),
      );
    });
  });

  describe("GET /api/files/starred", () => {
    it("should return starred files", async () => {
      File.find.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([{ ...mockFile, isStarred: true }]),
        }),
      });

      const res = await request(app).get("/api/files/starred");
      expect(res.statusCode).toBe(200);
      expect(res.body.items[0].isStarred).toBe(true);
      expect(File.find).toHaveBeenCalledWith(
        expect.objectContaining({ isStarred: true }),
      );
    });
  });

  describe("GET /api/files/trash", () => {
    it("should return trashed files", async () => {
      File.find.mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([{ ...mockFile, isTrash: true }]),
        }),
      });

      const res = await request(app).get("/api/files/trash");
      expect(res.statusCode).toBe(200);
      expect(res.body.items[0].isTrash).toBe(true);
      expect(File.find).toHaveBeenCalledWith(
        expect.objectContaining({ isTrash: true }),
      );
    });
  });

  describe("PATCH /api/files/:id/star", () => {
    it("should toggle star status", async () => {
      const fileInstance = { ...mockFile, save: vi.fn() };
      File.findOne.mockResolvedValue(fileInstance);

      const res = await request(app).patch("/api/files/file_id/star");
      expect(res.statusCode).toBe(200);
      expect(fileInstance.isStarred).toBe(true); // Toggled from false to true
      expect(fileInstance.save).toHaveBeenCalled();
    });
  });

  describe("PATCH /api/files/:id/trash", () => {
    it("should move file to trash", async () => {
      const fileInstance = { ...mockFile, save: vi.fn() };
      File.findOne.mockResolvedValue(fileInstance);

      const res = await request(app).patch("/api/files/file_id/trash");
      expect(res.statusCode).toBe(200);
      expect(fileInstance.isTrash).toBe(true);
      expect(fileInstance.save).toHaveBeenCalled();
    });
  });

  it("POST /api/files/upload should upload a file", async () => {
    try {
      const res = await request(app)
        .post("/api/files/upload")
        .attach("file", Buffer.from("test content"), "test.txt");

      if (res.statusCode !== 201) {
        console.log("Upload failed:", res.statusCode, res.body, res.text);
      }
      expect(res.statusCode).toEqual(201);
      // The response body IS the file object
      expect(res.body).toBeDefined();
      expect(res.body.name).toBe("test.txt");
    } catch (error) {
      console.error("Upload test error:", error);
      throw error;
    }
  });

  it("POST /api/files/upload should accept various file types", async () => {
    const types = [
      { name: "test.pdf", content: "pdf content", mime: "application/pdf" },
      { name: "test.json", content: "{}", mime: "application/json" },
      { name: "test.bin", content: "binary", mime: "application/octet-stream" },
    ];

    for (const file of types) {
      const res = await request(app)
        .post("/api/files/upload")
        .attach("file", Buffer.from(file.content), {
          filename: file.name,
          contentType: file.mime,
        });

      expect(res.statusCode).toEqual(201);
      expect(res.body.name).toBe(file.name);
    }
  });

  it("GET /api/files/stream/:id should stream file content", async () => {
    const res = await request(app)
      .get("/api/files/stream/file_id")
      .set("Range", "bytes=0-100");

    if (res.statusCode === 400) {
      console.log("Stream failed with 400:", res.text);
    }
    // Since we mock the stream to be empty/dummy, we just check status
    // Note: supertest might not handle streams perfectly with mocks, but status code should be 200 or 206
    expect(res.statusCode).toBeOneOf([200, 206]);
    expect(res.header["content-type"]).toContain("text/plain");
  });
});
