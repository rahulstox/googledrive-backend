import cron from "node-cron";
import File from "../models/File.js";
import User from "../models/User.js";
import { deleteFilePermanently } from "./fileService.js";

export const cleanupTrash = async () => {
  console.log("[Cron] Running trash cleanup job...");
  try {
    const users = await User.find({ isActive: true });
    let deletedCount = 0;

    for (const user of users) {
      const retentionDays = user.trashRetentionDays || 30;
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

      // Find items that are trashed and older than retention period
      const expiredFiles = await File.find({
        userId: user._id,
        isTrash: true,
        trashedAt: { $lt: cutoffDate },
      });

      if (expiredFiles.length > 0) {
        console.log(
          `[Cron] User ${user.email}: Found ${expiredFiles.length} expired items (older than ${retentionDays} days).`,
        );

        for (const file of expiredFiles) {
          // Check if file still exists (might have been deleted as a child of another folder in this loop)
          const exists = await File.exists({ _id: file._id });
          if (exists) {
            await deleteFilePermanently(file._id, user._id);
            deletedCount++;
          }
        }
      }
    }
    console.log(
      `[Cron] Trash cleanup completed. Total items permanently deleted: ${deletedCount}`,
    );
    return deletedCount;
  } catch (err) {
    console.error("[Cron] Trash cleanup failed:", err);
    throw err;
  }
};

export const startCronJobs = () => {
  console.log("Initializing cron jobs...");

  // Run every day at midnight (00:00)
  cron.schedule("0 0 * * *", cleanupTrash);
};
