import mongoose from "mongoose";
import { Router } from "express";
import { body } from "express-validator";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { rateLimit } from "express-rate-limit";
import passport from "passport";
import User from "../models/User.js";
import File from "../models/File.js";
import PasswordResetToken from "../models/PasswordResetToken.js";
import { validate } from "../middleware/validate.js";
import { protect } from "../middleware/auth.js";
import {
  sendActivationEmail,
  sendPasswordResetEmail,
  sendPasswordChangedEmail,
  sendAccountDeletionEmail,
} from "../services/emailService.js";
import { deleteFromS3 } from "../services/s3Service.js";

const router = Router();

const signToken = (id, tokenVersion = 0) =>
  jwt.sign({ id, v: tokenVersion }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });

// Rate limiters
const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // Limit each IP to 5 requests per windowMs
  message: { message: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: { message: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
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
    const user = await User.findOne({
      activationToken: req.params.token,
    }).select("+activationToken +activationTokenExpires");

    if (!user) {
      return res.status(400).json({
        message: "Activation link is invalid or has already been used.",
      });
    }

    if (user.activationTokenExpires < Date.now()) {
      return res
        .status(400)
        .json({ message: "Activation link expired. Please register again." });
    }

    user.isActive = true;
    user.activationToken = undefined;
    user.activationTokenExpires = undefined;
    await user.save();

    res.json({
      message: "Account activated successfully. You can now log in.",
    });
  } catch (err) {
    console.error("[Activate] Error:", err.message);
    res.status(500).json({ message: "Activation failed." });
  }
});

router.post(
  "/login",
  [
    body("email")
      .isEmail()
      .normalizeEmail()
      .withMessage("Valid email is required"),
    body("password").notEmpty().withMessage("Password is required"),
  ],
  validate,
  async (req, res) => {
    try {
      const { email, password } = req.body;
      const user = await User.findOne({ email }).select(
        "+password +tokenVersion",
      );

      if (!user || !(await user.comparePassword(password))) {
        return res.status(401).json({ message: "Invalid email or password" });
      }

      const token = user.getSignedJwtToken();

      res.cookie("token", token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      res.json({
        token,
        user: {
          id: user._id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          authProvider: user.authProvider,
        },
      });
    } catch (err) {
      console.error("[Login] Error:", err);
      res.status(500).json({ message: "Login failed." });
    }
  },
);

// Get Current User
router.get("/me", protect, async (req, res) => {
  res.json({ user: req.user });
});

router.post("/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ message: "Logged out successfully" });
});

// OAuth Routes
router.get(
  "/google",
  passport.authenticate("google", {
    scope: ["profile", "email"],
    session: false,
  }),
);

router.get(
  "/google/callback",
  passport.authenticate("google", {
    failureRedirect: "/login",
    session: false,
  }),
  (req, res) => {
    const token = req.user.getSignedJwtToken();
    res.redirect(
      `${process.env.FRONTEND_URL || "http://localhost:5173"}/auth/callback?token=${token}`,
    );
  },
);

router.get(
  "/github",
  passport.authenticate("github", { scope: ["user:email"], session: false }),
);

router.get(
  "/github/callback",
  passport.authenticate("github", {
    failureRedirect: "/login",
    session: false,
  }),
  (req, res) => {
    const token = req.user.getSignedJwtToken();
    res.redirect(
      `${process.env.FRONTEND_URL || "http://localhost:5173"}/auth/callback?token=${token}`,
    );
  },
);

// Forgot Password
router.post(
  "/forgot-password",
  forgotLimiter,
  [
    body("email")
      .isEmail()
      .normalizeEmail()
      .withMessage("Valid email is required"),
  ],
  validate,
  async (req, res) => {
    try {
      const { email } = req.body;
      const user = await User.findOne({ email });

      // Always return 204 to prevent user enumeration
      if (!user) {
        console.log(`[Forgot Password] User not found for email: ${email}`);
        return res.status(204).send();
      }

      // Generate token
      const resetToken = crypto.randomBytes(32).toString("base64url");
      const tokenHash = crypto
        .createHmac("sha256", process.env.JWT_SECRET) // Using JWT_SECRET as key for simplicity
        .update(resetToken)
        .digest("hex");

      const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

      await PasswordResetToken.create({
        userId: user._id,
        tokenHash,
        expiresAt,
      });

      // Use FRONTEND_URL env var, or fallback to request origin (for deployment), or localhost
      const baseUrl =
        process.env.FRONTEND_URL ||
        req.get("origin") ||
        "http://localhost:5173";

      // Encode email to base64url for URL safety
      const emailEncoded = Buffer.from(email).toString("base64url");
      const resetLink = `${baseUrl}/auth/reset-password?token=${resetToken}&email=${emailEncoded}`;

      console.log(
        `[Forgot Password] Sending email to ${email} with link: ${resetLink}`,
      );

      // Send email (async, don't await to block response, but catch errors)
      sendPasswordResetEmail(user.email, user.firstName, resetLink).catch(
        (err) => console.error("[Forgot Password] Email failed:", err),
      );

      res.status(204).send();
    } catch (err) {
      console.error("[Forgot Password] Error:", err.message);
      res.status(500).json({ message: "Request failed" });
    }
  },
);

// Verify Reset Token
router.post(
  "/verify-reset-token",
  [
    body("token").notEmpty().withMessage("Token is required"),
    body("email").notEmpty().withMessage("Email is required"),
  ],
  validate,
  async (req, res) => {
    try {
      const { token, email } = req.body;

      const user = await User.findOne({ email });
      if (!user) {
        return res.status(400).json({ message: "Invalid or expired link." });
      }

      const tokenHash = crypto
        .createHmac("sha256", process.env.JWT_SECRET)
        .update(token)
        .digest("hex");

      const resetTokenDoc = await PasswordResetToken.findOne({
        userId: user._id,
        tokenHash,
        consumed: false,
      });

      if (!resetTokenDoc || resetTokenDoc.expiresAt < Date.now()) {
        return res.status(400).json({ message: "Invalid or expired link." });
      }

      res.status(200).json({ message: "Token is valid." });
    } catch (err) {
      console.error("[Verify Token] Error:", err.message);
      res.status(500).json({ message: "Verification failed." });
    }
  },
);

// Reset Password
router.post(
  "/reset-password",
  resetLimiter,
  [
    body("token").notEmpty().withMessage("Token is required"),
    body("email").isEmail().withMessage("Valid email is required"),
    body("newPassword")
      .isLength({ min: 8 })
      .withMessage("Password must be at least 8 characters")
      .matches(
        /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/,
      )
      .withMessage(
        "Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character",
      ),
  ],
  validate,
  async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const { token, email, newPassword } = req.body;
      const user = await User.findOne({ email }).session(session);

      if (!user) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ message: "Invalid request." });
      }

      const tokenHash = crypto
        .createHmac("sha256", process.env.JWT_SECRET)
        .update(token)
        .digest("hex");

      const resetTokenDoc = await PasswordResetToken.findOne({
        userId: user._id,
        tokenHash,
        consumed: false,
      }).session(session);

      if (!resetTokenDoc || resetTokenDoc.expiresAt < Date.now()) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ message: "Invalid or expired link." });
      }

      // Mark token consumed
      resetTokenDoc.consumed = true;
      await resetTokenDoc.save({ session });

      // Update password
      user.password = newPassword;
      // Invalidate sessions
      user.tokenVersion = (user.tokenVersion || 0) + 1;
      await user.save({ session });

      await session.commitTransaction();
      session.endSession();

      // Send confirmation email (fire and forget)
      sendPasswordChangedEmail(user.email, user.firstName, {
        time: new Date().toLocaleString(),
        ip: req.ip,
        userAgent: req.get("User-Agent"),
      }).catch(console.error);

      res.status(204).send();
    } catch (err) {
      await session.abortTransaction();
      session.endSession();
      console.error("[Reset Password] Error:", err.message);
      res.status(500).json({ message: "Password reset failed." });
    }
  },
);

router.delete("/me", protect, async (req, res) => {
  const { password } = req.body;
  if (!password) {
    return res
      .status(400)
      .json({ message: "Password is required to delete account." });
  }

  const session = await mongoose.startSession();
  let transactionStarted = false;
  const userId = req.user.id;
  const logPrefix = `[Delete Account][User: ${userId}]`;

  console.log(`${logPrefix} Initiating account deletion process.`);

  try {
    const user = await User.findById(userId).select("+password");
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    // Re-authenticate
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: "Incorrect password." });
    }

    try {
      session.startTransaction();
      transactionStarted = true;
    } catch (txErr) {
      console.warn(
        `${logPrefix} Transactions not supported. Proceeding without transaction.`,
      );
    }

    // 1. Identify S3 keys to delete
    const files = await File.find({ userId }).session(session);
    const s3KeysToDelete = files.filter((f) => f.s3Key).map((f) => f.s3Key);

    // 2. Delete data
    // GDPR/CCPA Compliance: Permanent erasure of all user data
    await File.deleteMany({ userId }).session(session);
    await PasswordResetToken.deleteMany({ userId }).session(session);
    await User.findByIdAndDelete(userId).session(session);

    if (transactionStarted) {
      await session.commitTransaction();
    }

    // 3. Cleanup S3 (Post-commit)
    Promise.allSettled(s3KeysToDelete.map((key) => deleteFromS3(key))).then(
      (results) => {
        const failed = results.filter((r) => r.status === "rejected");
        if (failed.length > 0) {
          console.warn(
            `${logPrefix} Failed to delete ${failed.length} S3 objects.`,
          );
        }
      },
    );

    // 4. Send Email
    try {
      await sendAccountDeletionEmail(user.email, user.firstName);
    } catch (emailErr) {
      console.error(`${logPrefix} Failed to send email:`, emailErr);
    }

    res.json({
      message: "Account and all associated data permanently deleted.",
    });
  } catch (err) {
    console.error(`${logPrefix} Error:`, err);
    if (transactionStarted) {
      await session.abortTransaction();
    }
    res.status(500).json({ message: "Failed to delete account." });
  } finally {
    await session.endSession();
  }
});

export default router;
