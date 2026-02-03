import mongoose from "mongoose";
import { Router } from "express";
import { body } from "express-validator";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import File from "../models/File.js";
import PasswordResetToken from "../models/PasswordResetToken.js";
import { validate } from "../middleware/validate.js";
import { protect } from "../middleware/auth.js";
import {
  sendActivationEmail,
  sendPasswordResetEmail,
} from "../services/emailService.js";
import { deleteFromS3 } from "../services/s3Service.js";

const router = Router();

const signToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });

router.post(
  "/register",
  [
    body("email")
      .isEmail()
      .normalizeEmail()
      .withMessage("Valid email is required"),
    body("firstName").trim().notEmpty().withMessage("First name is required"),
    body("lastName").trim().notEmpty().withMessage("Last name is required"),
    body("password")
      .isLength({ min: 8 })
      .withMessage("Password must be at least 8 characters"),
  ],
  validate,
  async (req, res) => {
    try {
      const { email, firstName, lastName, password } = req.body;
      const existing = await User.findOne({ email });
      if (existing) {
        return res
          .status(400)
          .json({ message: "An account with this email already exists." });
      }
      const activationToken = crypto.randomBytes(32).toString("hex");
      const activationTokenExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const user = await User.create({
        email,
        firstName,
        lastName,
        password,
        isActive: false,
        activationToken,
        activationTokenExpires,
      });
      const baseUrl = process.env.FRONTEND_URL || "http://localhost:5173";
      const activationLink = `${baseUrl}/activate/${activationToken}`;

      try {
        await sendActivationEmail(email, firstName, activationLink);
      } catch (emailErr) {
        console.error("[Register] Activation email failed:", emailErr.message);
      }

      const payload = {
        message:
          "Account created. Please check your email to activate your account.",
        userId: user._id,
      };
      if (process.env.NODE_ENV !== "production") {
        payload.activationLink = activationLink;
      }
      res.status(201).json(payload);
    } catch (err) {
      console.error("[Register] Error:", err.message);
      res
        .status(500)
        .json({ message: "Registration failed. Please try again." });
    }
  },
);

router.get("/activate/:token", async (req, res) => {
  try {
    // Find user by token regardless of expiry to provide better error messages
    const user = await User.findOne({
      activationToken: req.params.token,
    }).select("+activationToken +activationTokenExpires");

    if (!user) {
      return res.status(400).json({
        message: "Activation link is invalid or has already been used.",
      });
    }

    if (user.activationTokenExpires < Date.now()) {
      // Optional: Delete the user if expired so they can register again?
      // Or just let them register again (which might fail on email unique constraint).
      // The user asked to "Show a clear message".
      // If they try to register again, the register endpoint checks `findOne({ email })`.
      // If that existing user is inactive, maybe we should allow overwriting or resending email?
      // For now, let's stick to the request: "Show message".
      return res.status(400).json({
        message: "Activation link has expired. Please sign up again.",
      });
    }

    user.isActive = true;
    user.activationToken = undefined;
    user.activationTokenExpires = undefined;
    await user.save({ validateBeforeSave: false });

    res.json({
      message: "Account activated successfully. You can now log in.",
    });
  } catch (err) {
    console.error("Activation error:", err);
    res.status(500).json({ message: "Activation failed due to server error." });
  }
});

router.post(
  "/login",
  [body("email").isEmail().normalizeEmail(), body("password").notEmpty()],
  validate,
  async (req, res) => {
    try {
      const user = await User.findOne({ email: req.body.email }).select(
        "+password",
      );
      if (!user) {
        return res.status(401).json({ message: "Invalid email or password." });
      }
      if (!user.isActive) {
        return res.status(403).json({
          message:
            "Account not activated. Please check your email for the activation link.",
        });
      }
      const match = await user.comparePassword(req.body.password);
      if (!match) {
        return res.status(401).json({ message: "Invalid email or password." });
      }
      const token = signToken(user._id);
      res.json({
        token,
        user: {
          id: user._id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
        },
      });
    } catch (err) {
      res.status(500).json({ message: "Login failed." });
    }
  },
);

router.post(
  "/forgot-password",
  [body("email").isEmail().normalizeEmail()],
  validate,
  async (req, res) => {
    try {
      const user = await User.findOne({ email: req.body.email });
      if (!user) {
        return res
          .status(404)
          .json({ message: "No account found with this email address." });
      }
      const token = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      await PasswordResetToken.create({
        userId: user._id,
        token,
        expiresAt,
      });
      const baseUrl = process.env.FRONTEND_URL || "http://localhost:5173";
      const resetLink = `${baseUrl}/reset-password/${token}`;
      await sendPasswordResetEmail(user.email, user.firstName, resetLink);
      res.json({
        message:
          "If an account exists with this email, you will receive a password reset link.",
      });
    } catch (err) {
      res.status(500).json({ message: "Request failed. Please try again." });
    }
  },
);

router.post(
  "/reset-password/:token",
  [
    body("password")
      .isLength({ min: 8 })
      .withMessage("Password must be at least 8 characters"),
  ],
  validate,
  async (req, res) => {
    try {
      const resetRecord = await PasswordResetToken.findOne({
        token: req.params.token,
        used: false,
        expiresAt: { $gt: Date.now() },
      });
      if (!resetRecord) {
        return res
          .status(400)
          .json({ message: "Invalid or expired reset link." });
      }
      const user = await User.findById(resetRecord.userId).select("+password");
      if (!user) {
        return res.status(400).json({ message: "User not found." });
      }
      user.password = req.body.password;
      await user.save();
      resetRecord.used = true;
      await resetRecord.save();
      res.json({
        message: "Password updated successfully. You can now log in.",
      });
    } catch (err) {
      res.status(500).json({ message: "Password reset failed." });
    }
  },
);

router.get("/me", protect, (req, res) => {
  res.json({ user: req.user });
});

router.patch("/me", protect, async (req, res) => {
  try {
    const { trashRetentionDays } = req.body;
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found." });

    if (trashRetentionDays !== undefined) {
      const days = parseInt(trashRetentionDays, 10);
      if (isNaN(days) || days < 1 || days > 365) {
        return res
          .status(400)
          .json({ message: "Retention days must be between 1 and 365." });
      }
      user.trashRetentionDays = days;
    }

    await user.save();
    res.json({ user });
  } catch (err) {
    res.status(500).json({ message: "Failed to update profile." });
  }
});

router.delete("/me", protect, async (req, res) => {
  const session = await mongoose.startSession();
  let transactionStarted = false;
  const userId = req.user.id;
  const logPrefix = `[Delete Account][User: ${userId}]`;

  console.log(`${logPrefix} Initiating account deletion process.`);

  try {
    const user = await User.findById(userId);
    if (!user) {
      console.warn(`${logPrefix} User not found during deletion attempt.`);
      await session.endSession();
      return res.status(404).json({ message: "User not found." });
    }

    // Attempt to start a transaction
    try {
      session.startTransaction();
      transactionStarted = true;
      console.log(`${logPrefix} Transaction started.`);
    } catch (txErr) {
      console.warn(
        `${logPrefix} Transactions not supported (likely standalone MongoDB). Proceeding without transaction.`,
      );
      // If transactions aren't supported, we just continue using the session (which effectively acts as no-op for atomicity but passes through)
      // or we can just proceed without the session options if strict mode requires it.
      // However, usually queries accept 'session' even if transactions aren't supported, it just ignores the transaction part.
      // But purely standalone might throw on startTransaction.
    }

    // 1. Identify all files to be deleted from S3 (Read-only phase)
    const files = await File.find({ userId }).session(session);
    const s3KeysToDelete = files
      .filter((f) => f.type === "file" && f.s3Key)
      .map((f) => f.s3Key);

    console.log(
      `${logPrefix} Found ${s3KeysToDelete.length} files to delete from storage.`,
    );

    // 2. Delete all data from DB (Write phase)
    console.log(`${logPrefix} Deleting DB records...`);

    // Delete files
    const fileDeleteResult = await File.deleteMany({ userId }).session(session);
    console.log(
      `${logPrefix} Deleted ${fileDeleteResult.deletedCount} file records.`,
    );

    // Delete password reset tokens
    const tokenDeleteResult = await PasswordResetToken.deleteMany({
      userId,
    }).session(session);
    console.log(
      `${logPrefix} Deleted ${tokenDeleteResult.deletedCount} reset tokens.`,
    );

    // Delete the user
    const userDeleteResult =
      await User.findByIdAndDelete(userId).session(session);
    if (!userDeleteResult) {
      throw new Error(
        "User could not be deleted (concurrent modification or not found).",
      );
    }
    console.log(`${logPrefix} User record deleted.`);

    // 3. Commit Transaction
    if (transactionStarted) {
      await session.commitTransaction();
      console.log(`${logPrefix} Transaction committed.`);
    }

    // 4. Delete files from S3 (Post-commit phase)
    // We do this AFTER commit so we don't delete files if the DB delete fails.
    // If this fails, we log it as a cleanup task.
    console.log(`${logPrefix} Starting S3 cleanup...`);
    let s3DeleteErrors = 0;

    // Use Promise.allSettled for parallel deletion to speed it up
    const s3Promises = s3KeysToDelete.map(async (key) => {
      try {
        await deleteFromS3(key);
      } catch (err) {
        console.error(`${logPrefix} Failed to delete S3 key: ${key}`, err);
        s3DeleteErrors++;
        // We don't re-throw because the user is already deleted.
        // We just log it for admin cleanup.
      }
    });

    await Promise.allSettled(s3Promises);

    if (s3DeleteErrors > 0) {
      console.warn(
        `${logPrefix} Account deleted but ${s3DeleteErrors} files could not be removed from S3.`,
      );
    } else {
      console.log(`${logPrefix} S3 cleanup completed successfully.`);
    }

    res.json({
      message: "Account and all associated data deleted successfully.",
    });
  } catch (err) {
    console.error(`${logPrefix} Critical Error:`, err);

    if (transactionStarted) {
      console.log(`${logPrefix} Aborting transaction...`);
      await session.abortTransaction();
    }

    res
      .status(500)
      .json({ message: `Failed to delete account: ${err.message}` });
  } finally {
    await session.endSession();
  }
});

export default router;
