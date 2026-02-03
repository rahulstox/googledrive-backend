import { Router } from "express";
import multer from "multer";
import multerS3 from "multer-s3";
import File from "../models/File.js";
import { protect } from "../middleware/auth.js";
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

const upload = multer({
  storage: multerS3({
    s3: s3Client,
    bucket: process.env.S3_BUCKET_NAME,
    contentType: multerS3.AUTO_CONTENT_TYPE,
    acl: "private",
    key: function (req, file, cb) {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      // Upload to a temp folder
      cb(null, `temp/${req.user.id}/${uniqueSuffix}-${file.originalname}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 * 1024 }, // 5GB limit
  fileFilter: (req, file, cb) => {
    // Allow all file types
    cb(null, true);
  },
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
    const s3Key = (
      parentDoc
        ? `${parentDoc.s3Key}/${folderName}`
        : getS3Key(req.user.id, folderName)
    ).replace(/\/+/g, "/");
    const existing = await File.findOne({ userId: req.user.id, s3Key });
    if (existing) {
      return res
        .status(400)
        .json({ message: "A folder with this name already exists here." });
    }
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

router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded." });
    }
    const baseParentId = req.body.parentId || null;
    const parentDoc = baseParentId
      ? await File.findOne({
          _id: baseParentId,
          userId: req.user.id,
          type: "folder",
        })
      : null;

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

    const rootPrefix = `users/${req.user.id}`;
    const baseKey = (parentDoc ? parentDoc.s3Key : rootPrefix).replace(
      /\/+$/g,
      "",
    );

    const parts = rel ? rel.split("/").filter((p) => p && p !== ".") : [];
    const relFileName = parts.length
      ? parts[parts.length - 1]
      : req.file.originalname;
    const safeFileName = relFileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const dirParts = parts.slice(0, -1);

    let currentParentId = parentDoc?._id || null;
    let currentKey = baseKey;

    for (const dirNameRaw of dirParts) {
      const dirName = dirNameRaw.replace(/[^a-zA-Z0-9._-]/g, "_");
      if (!dirName || dirName === ".") continue;
      const folderKey = `${currentKey}/${dirName}`.replace(/\/+/g, "/");
      let folder = await File.findOne({
        userId: req.user.id,
        s3Key: folderKey,
        type: "folder",
      });
      if (!folder) {
        folder = await File.create({
          name: dirName,
          type: "folder",
          s3Key: folderKey,
          parentId: currentParentId,
          userId: req.user.id,
        });
      }
      currentParentId = folder._id;
      currentKey = folder.s3Key;
    }

    let finalFileName = relFileName;
    let s3Key = `${currentKey}/${safeFileName}`.replace(/\/+/g, "/");

    // Handle duplicate filenames
    let counter = 1;
    while (await File.exists({ s3Key })) {
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
      const newSafeName = finalFileName.replace(/[^a-zA-Z0-9._-]/g, "_");
      s3Key = `${currentKey}/${newSafeName}`.replace(/\/+/g, "/");
      counter++;
    }

    // File is already uploaded to temp location by multer-s3
    const tempKey = req.file.key;

    // Move from temp to final location
    await copyInS3(tempKey, s3Key);
    await deleteFromS3(tempKey);

    const file = await File.create({
      name: finalFileName,
      type: "file",
      s3Key,
      size: req.file.size,
      mimeType: req.file.mimetype || req.file.contentType,
      parentId: currentParentId,
      userId: req.user.id,
    });
    res.status(201).json(file);
  } catch (err) {
    // If we fail after upload but before DB save, try to clean up temp file
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
    const rootPrefix = `users/${req.user.id}`;
    const newBaseKey = newParent ? newParent.s3Key : rootPrefix;
    const newS3Key = `${newBaseKey}/${item.name}`.replace(/\/+/g, "/");
    const existing = await File.findOne({
      userId: req.user.id,
      s3Key: newS3Key,
    });
    if (existing) {
      return res.status(400).json({
        message: "An item with this name already exists in the destination.",
      });
    }
    if (item.type === "file") {
      await copyInS3(item.s3Key, newS3Key);
      await deleteFromS3(item.s3Key);
      item.s3Key = newS3Key;
      item.parentId = newParent?._id || null;
      await item.save();
      return res.json(item);
    }
    const escapedOld = item.s3Key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const allDescendants = await File.find({
      userId: req.user.id,
      $or: [{ parentId: item._id }, { s3Key: new RegExp(`^${escapedOld}/`) }],
    }).sort({ s3Key: 1 });
    const updates = [{ doc: item, newKey: newS3Key }];
    for (const d of allDescendants) {
      const rel = d.s3Key.slice(item.s3Key.length).replace(/^\/+/, "");
      updates.push({
        doc: d,
        newKey: `${newS3Key}/${rel}`.replace(/\/+/g, "/"),
      });
    }
    for (const { doc, newKey } of updates) {
      if (doc.type === "file") {
        await copyInS3(doc.s3Key, newKey);
        await deleteFromS3(doc.s3Key);
      }
    }
    const keyToParentId = new Map();
    keyToParentId.set(newBaseKey, newParent?._id || null);
    for (const { doc, newKey } of updates.sort((a, b) =>
      a.newKey.localeCompare(b.newKey),
    )) {
      const parentPath = newKey.split("/").slice(0, -1).join("/");
      doc.s3Key = newKey;
      doc.parentId = keyToParentId.get(parentPath) ?? null;
      await doc.save();
      keyToParentId.set(newKey, doc._id);
    }
    const updated = await File.findOne({ _id: item._id, userId: req.user.id });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: err.message || "Move failed." });
  }
});

router.post("/upload-zip", upload.single("file"), async (req, res) => {
  try {
    if (!req.file || !req.file.originalname.toLowerCase().endsWith(".zip")) {
      return res.status(400).json({ message: "Please upload a .zip file." });
    }
    const AdmZip = (await import("adm-zip")).default;
    const parentId = req.body.parentId || null;
    let prefix = "";
    if (parentId) {
      const parent = await File.findOne({ _id: parentId, userId: req.user.id });
      if (parent) prefix = parent.s3Key + "/";
    }
    const zip = new AdmZip(req.file.buffer);
    const entries = zip.getEntries();
    const created = [];
    const folderIds = { "": null };
    for (const entry of entries) {
      const rawName = entry.entryName.replace(/\/$/, "");
      const parts = rawName.split("/").filter(Boolean);
      if (entry.isDirectory) {
        let path = "";
        for (let i = 0; i < parts.length; i++) {
          path += (path ? "/" : "") + parts[i];
          if (!folderIds[path]) {
            const parentPath = parts.slice(0, i).join("/");
            const parentFolderId = folderIds[parentPath];
            const s3Key = getS3Key(req.user.id, prefix + path);
            const existing = await File.findOne({ userId: req.user.id, s3Key });
            if (!existing) {
              const folder = await File.create({
                name: parts[i],
                type: "folder",
                s3Key,
                parentId: parentFolderId,
                userId: req.user.id,
              });
              folderIds[path] = folder._id;
              created.push(folder);
            } else {
              folderIds[path] = existing._id;
            }
          }
        }
        continue;
      }
      const dirPath = parts.slice(0, -1).join("/");
      const fileName = parts[parts.length - 1];
      let parentFolderId = folderIds[dirPath];
      if (dirPath && parentFolderId === undefined) {
        let p = "";
        for (let i = 0; i < parts.length - 1; i++) {
          p += (p ? "/" : "") + parts[i];
          if (!folderIds[p]) {
            const parentPath = parts.slice(0, i).join("/");
            const s3Key = getS3Key(req.user.id, prefix + p);
            const existing = await File.findOne({ userId: req.user.id, s3Key });
            if (existing) {
              folderIds[p] = existing._id;
            } else {
              const folder = await File.create({
                name: parts[i],
                type: "folder",
                s3Key,
                parentId: folderIds[parentPath] || null,
                userId: req.user.id,
              });
              folderIds[p] = folder._id;
              created.push(folder);
            }
          }
        }
        parentFolderId = folderIds[dirPath];
      }
      const filePath = (dirPath ? dirPath + "/" : "") + fileName;
      const s3Key = getS3Key(req.user.id, prefix + filePath);
      const data = entry.getData();
      const mime = entry.header?.contentType || "application/octet-stream";
      const buf = Buffer.isBuffer(data)
        ? data
        : Buffer.from(data || "", typeof data === "string" ? "utf8" : "latin1");
      const size = buf.length;
      await uploadToS3(s3Key, buf, mime);
      const file = await File.create({
        name: fileName,
        type: "file",
        s3Key,
        size,
        mimeType: mime,
        parentId: parentFolderId || null,
        userId: req.user.id,
      });
      created.push(file);
    }
    res.status(201).json({
      message: "Zip extracted.",
      created: created.length,
      items: created,
    });
  } catch (err) {
    console.error("Upload zip error:", err);
    res.status(500).json({ message: "Zip upload or extract failed." });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    console.log("DELETE /:id hit. Params:", req.params, "User:", req.user);
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

    if (items.length === 0) {
      return res.json({ message: "No items found." });
    }

    // Smart toggle: if any item is NOT starred, star them all.
    // If all are starred, unstar them all.
    const anyUnstarred = items.some((item) => !item.isStarred);
    const newStatus = anyUnstarred;

    await File.updateMany(
      { _id: { $in: ids }, userId: req.user.id },
      { $set: { isStarred: newStatus } }
    );

    res.json({
      message: newStatus ? "Added to Starred" : "Removed from Starred",
      status: newStatus,
    });
  } catch (err) {
    res.status(500).json({ message: err.message || "Bulk star failed." });
  }
});

router.post("/trash/bulk-restore", async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: "ids array is required." });
    }
    let count = 0;
    for (const id of ids) {
      if (await restoreFile(id, req.user.id)) {
        count++;
      }
    }
    res.json({ message: "Restored.", count });
  } catch (err) {
    res.status(500).json({ message: err.message || "Bulk restore failed." });
  }
});

router.delete("/trash/bulk-permanent", async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: "ids array is required." });
    }
    let count = 0;
    for (const id of ids) {
      if (await deleteFilePermanently(id, req.user.id)) {
        count++;
      }
    }
    res.json({ message: "Permanently deleted.", count });
  } catch (err) {
    res
      .status(500)
      .json({ message: err.message || "Bulk permanent delete failed." });
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
    res.status(500).json({ message: err.message || "Empty trash failed." });
  }
});

router.get("/folders", async (req, res) => {
  try {
    const folders = await File.find({
      userId: req.user.id,
      type: "folder",
      isTrash: false,
    })
      .sort({ s3Key: 1 })
      .select("_id name parentId s3Key")
      .lean();
    res.json({ folders });
  } catch (err) {
    res.status(500).json({ message: "Failed to list folders." });
  }
});

export default router;
