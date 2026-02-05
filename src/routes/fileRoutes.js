import { Router } from "express";
import multer from "multer";
import multerS3 from "multer-s3";
import File from "../models/File.js";
import User from "../models/User.js";
import { protect } from "../middleware/auth.js";
import { randomUUID } from "crypto";
import fs from "fs";
import os from "os";
import {
  getS3Key,
  uploadToS3,
  getPresignedDownloadUrl,
  getObjectStream,
  deleteFromS3,
  copyInS3,
  s3Client,
} from "../services/s3Service.js";
import {
  softDeleteFile,
  restoreFile,
  deleteFilePermanently,
} from "../services/fileService.js";

const router = Router();
router.use(protect);

// Pre-upload quota check (best effort)
const checkQuota = async (req, res, next) => {
  try {
    const contentLength = parseInt(req.headers["content-length"] || "0", 10);
    if (contentLength > 0) {
      if (req.user.storageUsed + contentLength > req.user.storageLimit) {
        // Drain request stream to prevent client ECONNRESET
        req.resume();
        return res.status(403).json({ message: "Storage quota exceeded." });
      }
    }
    next();
  } catch (err) {
    next(err);
  }
};

const upload = multer({
  storage: multerS3({
    s3: s3Client,
    bucket: process.env.S3_BUCKET_NAME,
    contentType: multerS3.AUTO_CONTENT_TYPE,
    acl: "private",
    key: function (req, file, cb) {
      // Use UUID for S3 key - Flat structure, immutable
      const fileId = randomUUID();
      const s3Key = `uploads/${req.user.id}/${fileId}`;
      cb(null, s3Key);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 * 1024 }, // 5GB limit
  fileFilter: (req, file, cb) => {
    cb(null, true);
  },
});

const uploadLocal = multer({ dest: os.tmpdir() });

router.get("/storage", async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select(
      "storageUsed storageLimit",
    );
    res.json({
      used: user.storageUsed,
      limit: user.storageLimit,
      percent:
        user.storageLimit > 0
          ? (user.storageUsed / user.storageLimit) * 100
          : 0,
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch storage info." });
  }
});

router.get("/search", async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || !q.trim()) {
      return res.json({ items: [] });
    }

    const items = await File.find({
      userId: req.user.id,
      name: { $regex: q.trim(), $options: "i" },
      isTrash: false,
    })
      .sort({ updatedAt: -1 })
      .limit(50) // Limit results for performance
      .lean();

    res.json({ items });
  } catch (err) {
    console.error("Search error:", err);
    res.status(500).json({ message: "Search failed." });
  }
});

router.get("/", async (req, res) => {
  try {
    const parentId = req.query.parentId || null;
    const items = await File.find({
      userId: req.user.id,
      parentId: parentId === "root" || parentId === "" ? null : parentId,
      isTrash: false,
    })
      .sort({ type: 1, name: 1 })
      .lean();
    res.json({ items });
  } catch (err) {
    res.status(500).json({ message: "Failed to list files." });
  }
});

router.get("/meta/:id", async (req, res) => {
  try {
    const item = await File.findOne({
      _id: req.params.id,
      userId: req.user.id,
    }).lean();
    if (!item) return res.status(404).json({ message: "Not found." });
    res.json({
      item: {
        _id: item._id,
        name: item.name,
        type: item.type,
        parentId: item.parentId || null,
      },
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to load item." });
  }
});

router.post("/folder", async (req, res) => {
  try {
    const { name, parentId } = req.body;
    if (!name?.trim()) {
      return res.status(400).json({ message: "Folder name is required." });
    }
    const parentDoc = parentId
      ? await File.findOne({
          _id: parentId,
          userId: req.user.id,
          type: "folder",
        })
      : null;

    const folderName = name.trim();

    // Check for existing folder with same name in same parent
    const existing = await File.findOne({
      userId: req.user.id,
      name: folderName,
      type: "folder",
      parentId: parentDoc?._id || null,
      isTrash: false,
    });

    if (existing) {
      return res
        .status(400)
        .json({ message: "A folder with this name already exists here." });
    }

    // For folders, s3Key is virtual/identifier, we use UUID
    const s3Key = `folders/${req.user.id}/${randomUUID()}`;

    const folder = await File.create({
      name: folderName,
      type: "folder",
      s3Key,
      parentId: parentDoc?._id || null,
      userId: req.user.id,
    });
    res.status(201).json(folder);
  } catch (err) {
    res.status(500).json({ message: "Failed to create folder." });
  }
});

router.post("/upload", checkQuota, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded." });
    }

    // Post-upload quota check (exact size)
    // If exceeded, delete file and revert
    if (req.user.storageUsed + req.file.size > req.user.storageLimit) {
      await deleteFromS3(req.file.key);
      return res.status(403).json({ message: "Storage quota exceeded." });
    }

    const baseParentId = req.body.parentId || null;
    const parentDoc = baseParentId
      ? await File.findOne({
          _id: baseParentId,
          userId: req.user.id,
          type: "folder",
        })
      : null;

    // Handle relative path upload (if provided) - simplified for new system
    // We only care about creating the folder structure in DB
    const rawRel =
      typeof req.body.relativePath === "string" ? req.body.relativePath : "";
    let rel = rawRel
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/\.\./g, "")
      .trim();
    if (rel === "." || rel === "./" || rel.startsWith("./")) {
      rel = rel === "." || rel === "./" ? "" : rel.replace(/^\.\/+/, "").trim();
    }

    const parts = rel ? rel.split("/").filter((p) => p && p !== ".") : [];
    const relFileName = parts.length
      ? parts[parts.length - 1]
      : req.file.originalname;
    const dirParts = parts.slice(0, -1);

    let currentParentId = parentDoc?._id || null;

    // Create folders if they don't exist
    for (const dirNameRaw of dirParts) {
      const dirName = dirNameRaw; // No need to sanitize for S3 anymore
      if (!dirName || dirName === ".") continue;

      let folder = await File.findOne({
        userId: req.user.id,
        name: dirName,
        type: "folder",
        parentId: currentParentId,
      });

      if (!folder) {
        folder = await File.create({
          name: dirName,
          type: "folder",
          s3Key: `folders/${req.user.id}/${randomUUID()}`,
          parentId: currentParentId,
          userId: req.user.id,
        });
      }
      currentParentId = folder._id;
    }

    // Check for duplicate filename in destination
    let finalFileName = relFileName;
    let counter = 1;

    while (
      await File.exists({
        userId: req.user.id,
        parentId: currentParentId,
        name: finalFileName,
        isTrash: false,
      })
    ) {
      const dotIndex = relFileName.lastIndexOf(".");
      let base, ext;
      if (dotIndex > 0) {
        base = relFileName.substring(0, dotIndex);
        ext = relFileName.substring(dotIndex);
      } else {
        base = relFileName;
        ext = "";
      }
      finalFileName = `${base} (${counter})${ext}`;
      counter++;
    }

    // Create File Record
    const file = await File.create({
      name: finalFileName,
      type: "file",
      s3Key: req.file.key, // Already uploaded to final UUID location
      size: req.file.size,
      mimeType: req.file.mimetype || req.file.contentType,
      parentId: currentParentId,
      userId: req.user.id,
    });

    // Update User Storage Usage
    await User.findByIdAndUpdate(req.user.id, {
      $inc: { storageUsed: req.file.size },
    });

    res.status(201).json(file);
  } catch (err) {
    // Cleanup if DB insert fails
    if (req.file && req.file.key) {
      try {
        await deleteFromS3(req.file.key);
      } catch (e) {
        console.error("Cleanup failed", e);
      }
    }
    console.error("Upload error:", err);
    res.status(500).json({ message: "Upload failed." });
  }
});

router.get("/stream/:id", async (req, res) => {
  try {
    const file = await File.findOne({
      _id: req.params.id,
      userId: req.user.id,
    });
    if (!file) {
      res.status(404).set("Content-Type", "text/plain").send("File not found.");
      return;
    }
    if (file.type !== "file") {
      res
        .status(400)
        .set("Content-Type", "text/plain")
        .send("Cannot stream a folder.");
      return;
    }

    const range = req.headers.range;
    const { body, contentType, contentLength, contentRange, acceptRanges } =
      await getObjectStream(file.s3Key, range);

    const filename = file.name.replace(/[^\w.\- ]/g, "_");
    const disposition = req.query.download === "1" ? "attachment" : "inline";

    const headers = {
      "Content-Type":
        file.mimeType || contentType || "application/octet-stream",
      "Content-Disposition": `${disposition}; filename="${filename}"`,
      "Accept-Ranges": acceptRanges || "bytes",
    };

    if (contentRange) {
      headers["Content-Range"] = contentRange;
      headers["Content-Length"] = contentLength;
      res.status(206);
    } else {
      headers["Content-Length"] = contentLength;
      res.status(200);
    }

    res.set(headers);
    body.pipe(res);
    body.on("error", (err) => {
      if (!res.headersSent)
        res
          .status(500)
          .set("Content-Type", "text/plain")
          .send("Stream failed.");
    });
  } catch (err) {
    if (!res.headersSent) {
      res
        .status(500)
        .set("Content-Type", "text/plain")
        .send(err.message || "Failed to stream file.");
    }
  }
});

router.get("/download/:id", async (req, res) => {
  try {
    const file = await File.findOne({
      _id: req.params.id,
      userId: req.user.id,
    });
    if (!file) {
      return res.status(404).json({ message: "File not found." });
    }
    if (file.type !== "file") {
      return res.status(400).json({ message: "Cannot download a folder." });
    }
    const url = await getPresignedDownloadUrl(file.s3Key);
    res.json({ url, name: file.name });
  } catch (err) {
    res.status(500).json({ message: "Failed to get download link." });
  }
});

router.get("/starred", async (req, res) => {
  try {
    const items = await File.find({
      userId: req.user.id,
      isStarred: true,
      isTrash: false,
    })
      .sort({ updatedAt: -1 })
      .lean();
    res.json({ items });
  } catch (err) {
    res.status(500).json({ message: "Failed to list starred files." });
  }
});

router.get("/trash", async (req, res) => {
  try {
    const items = await File.find({
      userId: req.user.id,
      isTrash: true,
    })
      .sort({ trashedAt: -1 })
      .lean();
    res.json({ items });
  } catch (err) {
    res.status(500).json({ message: "Failed to list trash files." });
  }
});

router.patch("/:id/star", async (req, res) => {
  try {
    const item = await File.findOne({
      _id: req.params.id,
      userId: req.user.id,
    });
    if (!item) return res.status(404).json({ message: "Not found" });
    item.isStarred = !item.isStarred;
    await item.save();
    res.json(item);
  } catch (err) {
    res.status(500).json({ message: "Failed to toggle star" });
  }
});

router.patch("/:id/trash", async (req, res) => {
  try {
    const item = await File.findOne({
      _id: req.params.id,
      userId: req.user.id,
    });
    if (!item) return res.status(404).json({ message: "Not found" });

    // Toggle trash status
    if (!item.isTrash) {
      await softDeleteFile(item._id, req.user.id);
    } else {
      await restoreFile(item._id, req.user.id);
    }

    // Fetch updated item to return
    const updated = await File.findOne({ _id: item._id, userId: req.user.id });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: "Failed to toggle trash" });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ message: "Name is required." });
    }
    const item = await File.findOne({
      _id: req.params.id,
      userId: req.user.id,
    });
    if (!item) {
      return res.status(404).json({ message: "Not found." });
    }
    item.name = name.trim();
    await item.save();
    res.json(item);
  } catch (err) {
    res.status(500).json({ message: "Rename failed." });
  }
});

router.post("/:id/move", async (req, res) => {
  try {
    const { parentId } = req.body;
    const item = await File.findOne({
      _id: req.params.id,
      userId: req.user.id,
    });
    if (!item) {
      return res.status(404).json({ message: "Not found." });
    }
    const newParentId =
      parentId === "root" || parentId === "" ? null : parentId;

    if (String(item.parentId || "") === String(newParentId || "")) {
      return res.json(item);
    }

    let newParent = null;
    if (newParentId) {
      newParent = await File.findOne({
        _id: newParentId,
        userId: req.user.id,
        type: "folder",
      });
      if (!newParent) {
        return res
          .status(400)
          .json({ message: "Destination folder not found." });
      }
      if (String(newParent._id) === String(item._id)) {
        return res.status(400).json({ message: "Cannot move into itself." });
      }
      // Check for cycles
      const ancestorIds = [];
      let a = newParent.parentId;
      while (a) {
        ancestorIds.push(String(a));
        const anc = await File.findOne({ _id: a, userId: req.user.id });
        a = anc?.parentId || null;
      }
      if (ancestorIds.includes(String(item._id))) {
        return res
          .status(400)
          .json({ message: "Cannot move folder into its own descendant." });
      }
    }

    // Check name collision in destination
    const existing = await File.findOne({
      userId: req.user.id,
      parentId: newParentId,
      name: item.name,
      isTrash: false,
    });

    if (existing) {
      return res.status(400).json({
        message: "An item with this name already exists in the destination.",
      });
    }

    // Move is now DB-only (S3 key is immutable)
    item.parentId = newParentId;
    await item.save();

    res.json(item);
  } catch (err) {
    res.status(500).json({ message: err.message || "Move failed." });
  }
});

router.post(
  "/upload-zip",
  checkQuota,
  uploadLocal.single("file"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "Please upload a .zip file." });
      }

      const AdmZip = (await import("adm-zip")).default;
      // Read file into buffer to avoid file locking issues on Windows
      const zipBuffer = fs.readFileSync(req.file.path);
      const zip = new AdmZip(zipBuffer);
      const entries = zip.getEntries();

      // 1. Calculate total uncompressed size
      let totalSize = 0;
      for (const entry of entries) {
        if (!entry.isDirectory) {
          totalSize += entry.header.size;
        }
      }

      // 2. Check quota (uncompressed)
      if (req.user.storageUsed + totalSize > req.user.storageLimit) {
        try {
          fs.unlinkSync(req.file.path);
        } catch (e) {
          console.warn("Failed to delete temp zip:", e.message);
        }
        return res
          .status(403)
          .json({ message: "Storage quota exceeded (uncompressed size)." });
      }

      // 3. Process entries
      const parentId = req.body.parentId || null;
      let createdCount = 0;
      const pathMap = new Map(); // "path/to/folder" -> folderId
      pathMap.set("", parentId);

      // Helper to ensure path exists in DB
      const ensurePath = async (entryPath) => {
        const parts = entryPath.split("/").filter(Boolean);
        let currentPath = "";
        let currentParentId = parentId;

        for (const part of parts) {
          const nextPath = currentPath ? `${currentPath}/${part}` : part;
          if (pathMap.has(nextPath)) {
            currentParentId = pathMap.get(nextPath);
          } else {
            // Check if folder exists in DB
            let folder = await File.findOne({
              name: part,
              type: "folder",
              parentId: currentParentId,
              userId: req.user.id,
              isTrash: false,
            });

            if (!folder) {
              folder = await File.create({
                name: part,
                type: "folder",
                s3Key: `folders/${req.user.id}/${randomUUID()}`,
                parentId: currentParentId,
                userId: req.user.id,
              });
            }

            currentParentId = folder._id;
            pathMap.set(nextPath, folder._id);
          }
          currentPath = nextPath;
        }
        return currentParentId;
      };

      const uploadedFiles = [];

      for (const entry of entries) {
        if (entry.isDirectory) {
          await ensurePath(entry.entryName);
          continue;
        }

        // File processing
        const entryName = entry.entryName;
        // Skip Mac OS metadata
        if (entryName.includes("__MACOSX") || entryName.includes(".DS_Store"))
          continue;

        const lastSlash = entryName.lastIndexOf("/");
        const fileName =
          lastSlash === -1 ? entryName : entryName.substring(lastSlash + 1);
        const folderPath =
          lastSlash === -1 ? "" : entryName.substring(0, lastSlash);

        if (!fileName) continue;

        const parentFolderId = await ensurePath(folderPath);

        const fileId = randomUUID();
        const s3Key = `uploads/${req.user.id}/${fileId}`;
        const buffer = entry.getData();

        await uploadToS3(s3Key, buffer, "application/octet-stream");

        const file = await File.create({
          name: fileName,
          type: "file",
          s3Key,
          size: entry.header.size,
          mimeType: "application/octet-stream",
          parentId: parentFolderId,
          userId: req.user.id,
        });

        uploadedFiles.push(file);
        createdCount++;
      }

      // Update storage used
      await User.findByIdAndUpdate(req.user.id, {
        $inc: { storageUsed: totalSize },
      });

      // Cleanup temp zip
      fs.unlinkSync(req.file.path);

      res.status(201).json({
        message: "Zip extracted successfully.",
        count: createdCount,
      });
    } catch (err) {
      console.error("Upload zip error:", err);
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      res.status(500).json({ message: "Zip upload or extract failed." });
    }
  },
);

router.delete("/:id", async (req, res) => {
  try {
    const item = await File.findOne({
      _id: req.params.id,
      userId: req.user.id,
    });
    if (!item) return res.status(404).json({ message: "File not found." });

    const success = await deleteFilePermanently(req.params.id, req.user.id);
    if (!success) {
      return res.status(404).json({ message: "File not found." });
    }

    res.json({ message: "Permanently deleted." });
  } catch (err) {
    console.error("DELETE /:id error:", err);
    res.status(500).json({ message: err.message || "Delete failed." });
  }
});

router.post("/restore/:id", async (req, res) => {
  try {
    const success = await restoreFile(req.params.id, req.user.id);
    if (!success) {
      return res.status(404).json({ message: "File not found." });
    }
    res.json({ message: "Restored." });
  } catch (err) {
    res.status(500).json({ message: err.message || "Restore failed." });
  }
});

router.delete("/permanent/:id", async (req, res) => {
  try {
    const item = await File.findOne({
      _id: req.params.id,
      userId: req.user.id,
    });
    if (!item) return res.status(404).json({ message: "File not found." });

    const success = await deleteFilePermanently(req.params.id, req.user.id);
    if (!success) {
      return res.status(404).json({ message: "File not found." });
    }

    res.json({ message: "Permanently deleted." });
  } catch (err) {
    res
      .status(500)
      .json({ message: err.message || "Permanent delete failed." });
  }
});

router.delete("/trash/empty", async (req, res) => {
  try {
    const files = await File.find({ userId: req.user.id, isTrash: true });
    let count = 0;
    for (const file of files) {
      if (await deleteFilePermanently(file._id, req.user.id)) {
        count++;
      }
    }
    res.json({ message: "Trash emptied.", count });
  } catch (err) {
    res.status(500).json({ message: "Failed to empty trash." });
  }
});

router.post("/bulk-delete", async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: "ids array is required." });
    }
    let count = 0;
    for (const id of ids) {
      if (await softDeleteFile(id, req.user.id)) {
        count++;
      }
    }
    res.json({ message: "Moved to trash.", count });
  } catch (err) {
    res.status(500).json({ message: err.message || "Bulk delete failed." });
  }
});

router.post("/bulk-star", async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: "ids array is required." });
    }

    const items = await File.find({
      _id: { $in: ids },
      userId: req.user.id,
    });

    const anyUnstarred = items.some((item) => !item.isStarred);
    const newStatus = anyUnstarred;

    await File.updateMany(
      { _id: { $in: ids }, userId: req.user.id },
      { $set: { isStarred: newStatus } },
    );

    res.json({
      message: newStatus ? "Added to Starred" : "Removed from Starred",
      status: newStatus,
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to toggle star status." });
  }
});

export default router;
