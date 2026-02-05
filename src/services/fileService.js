import File from "../models/File.js";
import User from "../models/User.js";
import { deleteFromS3 } from "./s3Service.js";

/**
 * Permanently deletes a file or folder and its descendants from DB and S3.
 * Updates user storage quota.
 * @param {string} fileId
 * @param {string} userId
 */
export async function deleteFilePermanently(fileId, userId) {
  const item = await File.findOne({ _id: fileId, userId });
  if (!item) return false;

  let totalSizeFreed = 0;

  if (item.type === "folder") {
    const escapedKey = item.s3Key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const children = await File.find({
      userId,
      $or: [{ parentId: item._id }, { s3Key: new RegExp(`^${escapedKey}/`) }],
    });

    for (const c of children) {
      if (c.type === "file") {
        await deleteFromS3(c.s3Key);
        totalSizeFreed += c.size || 0;
      }
      await File.deleteOne({ _id: c._id });
    }
  } else {
    await deleteFromS3(item.s3Key);
    totalSizeFreed += item.size || 0;
  }

  await File.deleteOne({ _id: item._id });

  if (totalSizeFreed > 0) {
    await User.findByIdAndUpdate(userId, {
      $inc: { storageUsed: -totalSizeFreed },
    });
  }

  return true;
}

/**
 * Soft deletes a file or folder (moves to trash).
 * @param {string} fileId
 * @param {string} userId
 */
export async function softDeleteFile(fileId, userId) {
  const item = await File.findOne({ _id: fileId, userId });
  if (!item) return false;

  // We only mark the item itself as trashed.
  // The frontend/backend should filter out children of trashed folders if needed,
  // or we can recursively trash children.
  // Google Drive recursively trashes.
  // Let's recursively trash children to keep it consistent.

  const now = new Date();

  if (item.type === "folder") {
    const escapedKey = item.s3Key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const children = await File.find({
      userId,
      $or: [{ parentId: item._id }, { s3Key: new RegExp(`^${escapedKey}/`) }],
    });

    for (const c of children) {
      if (!c.isTrash) {
        c.isTrash = true;
        c.trashedAt = now;
        await c.save();
      }
    }
  }

  if (!item.isTrash) {
    item.isTrash = true;
    item.trashedAt = now;
    await item.save();
  }

  return true;
}

/**
 * Restores a file or folder from trash.
 * @param {string} fileId
 * @param {string} userId
 */
export async function restoreFile(fileId, userId) {
  const item = await File.findOne({ _id: fileId, userId });
  if (!item) return false;

  // Recursively restore children?
  // Google Drive restores children if they were trashed WITH the folder.
  // But here we just checking trashedAt.
  // Simple approach: Recursively restore everything under the folder.

  if (item.type === "folder") {
    const escapedKey = item.s3Key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const children = await File.find({
      userId,
      $or: [{ parentId: item._id }, { s3Key: new RegExp(`^${escapedKey}/`) }],
    });

    for (const c of children) {
      if (c.isTrash) {
        c.isTrash = false;
        c.trashedAt = null;
        await c.save();
      }
    }
  }

  item.isTrash = false;
  item.trashedAt = null;
  await item.save();

  return true;
}
