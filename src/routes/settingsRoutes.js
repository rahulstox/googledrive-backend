import express from "express";
import { protect, authorize } from "../middleware/auth.js";
import User from "../models/User.js";
import File from "../models/File.js";

const router = express.Router();

// Public Config (Feature Flags, etc.)
// No auth required as this is needed for login/register pages
router.get("/public-config", (req, res) => {
  res.json({
    allowRegistration: process.env.ALLOW_REGISTRATION !== "false",
    enable2FA: process.env.ENABLE_2FA !== "false",
    maxUploadSize: parseInt(process.env.MAX_UPLOAD_SIZE) || 1073741824, // 1GB
    supportEmail: process.env.SUPPORT_EMAIL || "support@kryptondrive.com",
    appName: "Krypton Drive",
    version: "1.0.0",
  });
});

// Admin Stats
router.get("/admin/stats", protect, authorize("admin"), async (req, res) => {
  try {
    const userStats = await User.aggregate([
      {
        $group: {
          _id: null,
          totalUsers: { $sum: 1 },
          activeUsers: { $sum: { $cond: ["$isActive", 1, 0] } },
          totalStorage: { $sum: "$storageUsed" },
        },
      },
    ]);

    const stats = userStats[0] || {
      totalUsers: 0,
      activeUsers: 0,
      totalStorage: 0,
    };

    const totalFiles = await File.countDocuments({ isDeleted: false });

    res.json({
      totalUsers: stats.totalUsers,
      activeUsers: stats.activeUsers,
      totalStorageUsed: stats.totalStorage,
      totalFiles,
      timestamp: new Date(),
    });
  } catch (err) {
    console.error("Admin Stats Error:", err);
    res.status(500).json({ message: "Failed to fetch system stats" });
  }
});

// Admin Audit (Recent Activity)
router.get("/admin/audit", protect, authorize("admin"), async (req, res) => {
  try {
    const auditLogs = await User.aggregate([
      { $match: { "loginHistory.0": { $exists: true } } },
      { $project: { email: 1, loginHistory: 1 } },
      { $unwind: "$loginHistory" },
      { $sort: { "loginHistory.timestamp": -1 } },
      { $limit: 20 },
      {
        $project: {
          _id: 0,
          user: "$email",
          action: { $literal: "Login" },
          ip: "$loginHistory.ip",
          timestamp: "$loginHistory.timestamp",
          details: "$loginHistory.device",
        },
      },
    ]);

    res.json({ logs: auditLogs });
  } catch (err) {
    console.error("Admin Audit Error:", err);
    res.status(500).json({ message: "Failed to fetch audit logs" });
  }
});

export default router;
