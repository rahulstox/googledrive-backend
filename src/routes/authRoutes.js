import mongoose from "mongoose";
import { Router } from "express";
import { body } from "express-validator";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { rateLimit } from "express-rate-limit";
import passport from "passport";
import speakeasy from "speakeasy";
import qrcode from "qrcode";
import User from "../models/User.js";
import File from "../models/File.js";
import PasswordResetToken from "../models/PasswordResetToken.js";
import { validate } from "../middleware/validate.js";
import { protect, authenticate } from "../middleware/auth.js";
import { cache } from "../services/cacheService.js";
import {
  sendActivationEmail,
  sendPasswordResetEmail,
  sendPasswordChangedEmail,
  sendAccountDeletionEmail,
} from "../services/emailService.js";
import { deleteFromS3 } from "../services/s3Service.js";
import {
  registrationTotal,
  registrationDuration,
  emailSendTotal,
  activationTotal,
  loginDuration,
} from "../services/metrics.js";

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

const resendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // Limit each IP to 5 requests per windowMs
  message: { message: "Too many resend requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

const activationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 activation attempts
  message: { message: "Too many activation attempts, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post(
  "/register",
  [
    body("email")
      .matches(
        /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}))$/,
      )
      .withMessage("Please provide a valid email address")
      .normalizeEmail(),
    body("password")
      .isLength({ min: 8 })
      .withMessage("Password must be at least 8 characters"),
    body("username")
      .optional()
      .trim()
      .isLength({ min: 3 })
      .withMessage("Username must be at least 3 characters")
      .matches(/^[A-Za-z0-9_-]+$/)
      .withMessage(
        "Username can only contain letters, numbers, underscores, and hyphens",
      ),
  ],
  validate,
  async (req, res) => {
    const requestId =
      req.headers["x-request-id"] ||
      `req-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    // console.log(
    //   `[Register][${requestId}] Request received for email: ${req.body.email}`,
    // );
    // console.time(`[Register][${requestId}] Total Duration`);

    // Start metrics timer
    const endTimer = registrationDuration.startTimer();

    try {
      let { email, password, username } = req.body;

      // Auto-generate username if not provided
      if (!username) {
        const base = email.split("@")[0].replace(/[^a-zA-Z0-9]/g, "");
        const randomSuffix = Math.floor(1000 + Math.random() * 9000);
        username = `${base.substring(0, 15)}${randomSuffix}`;
      }

      // console.log(`[Register][${requestId}] Validating input...`);
      const existing = await User.findOne({ email }).select(
        "+isActive +activationToken +activationTokenExpires",
      );

      if (existing) {
        if (existing.isActive) {
          // console.log(
          //   `[Register][${requestId}] Active user already exists: ${email}`,
          // );
          // console.timeEnd(`[Register][${requestId}] Total Duration`);
          registrationTotal.inc({ status: "failed_exists" });
          return res
            .status(400)
            .json({ message: "An account with this email already exists." });
        }

        // Handle unactivated account: Resend activation email
        // console.log(
        //   `[Register][${requestId}] Unactivated user exists. Checking token validity...`,
        // );

        let activationToken = existing.activationToken;
        let activationTokenExpires = existing.activationTokenExpires;

        // Reuse existing token if it has at least 2 minutes of validity left
        // This prevents race conditions where a user clicks a "stale" link from a previous email
        if (
          !activationToken ||
          !activationTokenExpires ||
          activationTokenExpires < Date.now() + 2 * 60 * 1000
        ) {
          // console.log(
          //   `[Register][${requestId}] Token expired or missing. Generating new one...`,
          // );
          activationToken = jwt.sign({ email }, process.env.JWT_SECRET, {
            expiresIn: "10m",
          });
          activationTokenExpires = new Date(Date.now() + 10 * 60 * 1000);
          existing.activationToken = activationToken;
          existing.activationTokenExpires = activationTokenExpires;
          await existing.save();
        } else {
          // console.log(
          //   `[Register][${requestId}] Existing token is valid. Reusing...`,
          // );
        }

        const baseUrl = process.env.FRONTEND_URL || "http://localhost:5173";
        const activationLink = `${baseUrl}/activate?token=${activationToken}`;

        // Fire-and-forget email
        sendActivationEmail(email, existing.username || "User", activationLink)
          .then(() => {
            // console.log(`[Register][${requestId}] Re-activation email sent.`);
            emailSendTotal.inc({ status: "resend_success" });
          })
          .catch((err) => {
            console.error(
              `[Register][${requestId}] Email failed:`,
              err.message,
            );
            emailSendTotal.inc({ status: "resend_failed" });
          });

        const payload = {
          message:
            "Account created. Please check your email to activate your account.",
          userId: existing._id,
        };
        if (process.env.NODE_ENV !== "production") {
          payload.activationLink = activationLink;
        }

        // console.timeEnd(`[Register][${requestId}] Total Duration`);
        registrationTotal.inc({ status: "resend_success" });
        return res.status(200).json(payload);
      }

      // console.log(`[Register][${requestId}] Generating activation token...`);
      // Create JWT activation token
      const activationToken = jwt.sign({ email }, process.env.JWT_SECRET, {
        expiresIn: "10m",
      });
      const activationTokenExpires = new Date(Date.now() + 10 * 60 * 1000);

      // console.log(`[Register][${requestId}] Creating user in DB...`);
      // console.time(`[Register][${requestId}] DB Create`);
      const user = await User.create({
        email,
        password,
        username,
        isActive: false,
        activationToken,
        activationTokenExpires,
      });
      // console.timeEnd(`[Register][${requestId}] DB Create`);
      // console.log(`[Register][${requestId}] User created with ID: ${user._id}`);

      const baseUrl = process.env.FRONTEND_URL || "http://localhost:5173";
      if (!baseUrl.startsWith("http")) {
        console.warn(
          `[Register][${requestId}] Warning: FRONTEND_URL does not start with http(s): ${baseUrl}`,
        );
      }
      const activationLink = `${baseUrl}/activate?token=${activationToken}`;

      // console.log(
      //   `[Register][${requestId}] Sending activation email (Background)...`,
      // );

      // Fire-and-forget email sending
      sendActivationEmail(email, "User", activationLink)
        .then(() => {
          // console.log(`[Register][${requestId}] Email sent successfully.`);
          emailSendTotal.inc({ status: "success" });
        })
        .catch((emailErr) => {
          console.error(
            `[Register][${requestId}] Activation email failed:`,
            emailErr.message,
          );
          // Log the link so admin can manually activate if needed
          console.error(
            `[Register][${requestId}] MANUAL ACTIVATION LINK: ${activationLink}`,
          );
          emailSendTotal.inc({ status: "failed" });
        });

      // No console.timeEnd for email since it's async now

      const payload = {
        message:
          "Account created. Please check your email to activate your account.",
        userId: user._id,
      };
      if (process.env.NODE_ENV !== "production") {
        payload.activationLink = activationLink;
      }
      // console.timeEnd(`[Register][${requestId}] Total Duration`);

      // End metrics timer and increment success
      endTimer();
      registrationTotal.inc({ status: "success" });

      res.status(201).json(payload);
    } catch (err) {
      console.error(`[Register][${requestId}] Error:`, err.message);
      // console.timeEnd(`[Register][${requestId}] Total Duration`);
      registrationTotal.inc({ status: "error" });

      if (err.code === 11000) {
        return res
          .status(400)
          .json({ message: "An account with this email already exists." });
      }

      res
        .status(500)
        .json({ message: "Registration failed. Please try again." });
    }
  },
);

router.get("/activate", activationLimiter, async (req, res) => {
  try {
    const token = req.query.token;
    if (!token) {
      return res.status(400).json({ message: "Activation token is missing." });
    }

    // Verify JWT
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (e) {
      return res
        .status(400)
        .json({ message: "Invalid or expired activation token." });
    }

    const user = await User.findOne({
      email: decoded.email,
      activationToken: token,
    }).select("+activationToken +activationTokenExpires");

    if (!user) {
      return res.status(400).json({
        message: "Activation link is invalid or has already been used.",
      });
    }

    if (user.activationTokenExpires < Date.now()) {
      return res.status(400).json({
        message: "Activation link has expired. Please register again.",
      });
    }

    user.isActive = true;
    user.activationToken = undefined;
    user.activationTokenExpires = undefined;
    await user.save();

    // Invalidate cache and set new active user to prevent race conditions
    const cacheKey = `user:${user._id.toString()}`;
    await cache.del(cacheKey);
    // Proactively set the active user in cache
    await cache.set(cacheKey, JSON.stringify(user.toObject()));

    activationTotal.inc({ status: "success" });

    // Auto-login logic
    const tokenPayload = user.getSignedJwtToken();

    res.cookie("token", tokenPayload, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.status(200).json({
      message: "Account activated successfully.",
      token: tokenPayload,
      user: {
        id: user._id,
        email: user.email,
        username: user.username,
        authProvider: user.authProvider,
      },
    });
  } catch (err) {
    console.error("[Activate] Error:", err.message);
    activationTotal.inc({ status: "error" });
    res.status(500).json({ message: "Activation failed." });
  }
});

router.post(
  "/resend-activation",
  resendLimiter,
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

      if (!user) {
        // Return success even if user not found to prevent enumeration
        return res
          .status(200)
          .json({ message: "If account exists, activation email sent." });
      }

      if (user.isActive) {
        return res.status(200).json({ message: "Account already active." });
      }

      let activationToken = user.activationToken;
      let activationTokenExpires = user.activationTokenExpires;

      // Reuse existing token if valid (> 2 mins remaining)
      if (
        !activationToken ||
        !activationTokenExpires ||
        activationTokenExpires < Date.now() + 2 * 60 * 1000
      ) {
        activationToken = jwt.sign({ email }, process.env.JWT_SECRET, {
          expiresIn: "10m",
        });
        activationTokenExpires = new Date(Date.now() + 10 * 60 * 1000);
        user.activationToken = activationToken;
        user.activationTokenExpires = activationTokenExpires;
        await user.save();
      }

      const baseUrl = process.env.FRONTEND_URL || "http://localhost:5173";
      const activationLink = `${baseUrl}/activate?token=${activationToken}`;

      await sendActivationEmail(user.email, "User", activationLink);
      emailSendTotal.inc({ status: "resend_success" });

      res.status(200).json({ message: "Activation email sent." });
    } catch (err) {
      console.error("[ResendActivation] Error:", err.message);
      emailSendTotal.inc({ status: "resend_error" });
      res.status(500).json({ message: "Failed to send activation email." });
    }
  },
);

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
    const endTimer = loginDuration.startTimer();
    try {
      const { email, password, otp } = req.body;
      const user = await User.findOne({ email }).select(
        "+password +tokenVersion +twoFactorEnabled +twoFactorSecret",
      );

      if (!user || !(await user.comparePassword(password))) {
        return res.status(401).json({ message: "Invalid email or password" });
      }

      if (!user.isActive) {
        return res
          .status(403)
          .json({ message: "Account not activated. Please check your email." });
      }

      // 2FA Verification
      if (user.twoFactorEnabled) {
        if (!otp) {
          return res.status(403).json({
            message: "2FA token required",
            require2fa: true,
          });
        }
        const verified = speakeasy.totp.verify({
          secret: user.twoFactorSecret,
          encoding: "base32",
          token: otp,
        });
        if (!verified) {
          return res.status(401).json({
            message: "Invalid 2FA token",
            require2fa: true,
          });
        }
      }

      const token = user.getSignedJwtToken();

      // Track login history
      const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
      const device = req.headers["user-agent"] || "Unknown";

      // Limit history to last 10 entries
      if (user.loginHistory.length >= 10) {
        user.loginHistory.shift();
      }
      user.loginHistory.push({
        ip,
        device,
        timestamp: new Date(),
      });
      await user.save({ validateBeforeSave: false });

      // Pre-warm cache to speed up subsequent requests
      try {
        const userForCache = user.toObject();
        delete userForCache.password;
        await cache.set(
          `user:${user._id.toString()}`,
          JSON.stringify(userForCache),
        );
      } catch (cacheErr) {
        console.error("[Login] Cache warm-up failed:", cacheErr);
        // Continue login even if cache fails
      }

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
          username: user.username,
          authProvider: user.authProvider,
          twoFactorEnabled: user.twoFactorEnabled,
        },
      });
      endTimer();
    } catch (err) {
      endTimer();
      console.error("[Login] Error:", err);
      res.status(500).json({ message: "Login failed." });
    }
  },
);

// Get Current User
router.get("/me", protect, async (req, res) => {
  res.json({ user: req.user });
});

// Check Username Availability
router.get("/check-username", async (req, res) => {
  try {
    const { u } = req.query;
    if (!u) return res.status(400).json({ message: "Username is required" });

    // Only check if valid format
    if (!/^[A-Za-z0-9_-]{3,20}$/.test(u)) {
      return res.status(400).json({ message: "Invalid format" });
    }

    const exists = await User.exists({ username: u });
    res.json({ exists: !!exists });
  } catch (err) {
    console.error("[CheckUsername] Error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Update Current User
router.put(
  "/me",
  protect,
  [
    body("username")
      .optional()
      .trim()
      .matches(/^[A-Za-z0-9_-]{3,20}$/)
      .withMessage(
        "Username must be 3-20 characters and can only contain letters, numbers, underscores, and hyphens",
      ),
    body("bio")
      .optional()
      .trim()
      .isLength({ max: 500 })
      .withMessage("Bio cannot exceed 500 characters"),
    body("phoneNumber").optional().trim(),
  ],
  validate,
  async (req, res) => {
    try {
      const { username, bio, phoneNumber, preferences, avatarUrl } = req.body;
      const user = req.user;

      if (username) {
        // Check uniqueness if changing
        if (user.username !== username) {
          const exists = await User.exists({ username });
          if (exists) {
            return res.status(400).json({ message: "Username already taken" });
          }
          user.username = username;
        }
      }

      if (bio !== undefined) user.bio = bio;
      if (phoneNumber !== undefined) user.phoneNumber = phoneNumber;
      if (avatarUrl !== undefined) user.avatarUrl = avatarUrl;

      if (preferences) {
        // Merge preferences
        user.preferences = {
          ...user.preferences,
          ...preferences,
          notifications: {
            ...user.preferences.notifications,
            ...(preferences.notifications || {}),
          },
          privacy: {
            ...user.preferences.privacy,
            ...(preferences.privacy || {}),
          },
        };
      }

      await user.save();

      // Invalidate cache
      const cacheKey = `user:${user._id.toString()}`;
      await cache.del(cacheKey);
      await cache.set(cacheKey, JSON.stringify(user.toObject()));

      res.json({
        message: "Profile updated successfully",
        user: {
          id: user._id,
          email: user.email,
          username: user.username,
          authProvider: user.authProvider,
        },
      });
    } catch (err) {
      console.error("[UpdateProfile] Error:", err);
      res.status(500).json({ message: "Failed to update profile" });
    }
  },
);

// Change Password
router.put(
  "/password",
  protect,
  [
    body("currentPassword")
      .notEmpty()
      .withMessage("Current password is required"),
    body("newPassword")
      .isLength({ min: 8 })
      .withMessage("New password must be at least 8 characters"),
  ],
  validate,
  async (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body;

      // Get user with password selected
      const user = await User.findById(req.user.id).select("+password");

      if (!user.password) {
        return res.status(400).json({
          message:
            "You are logged in via social provider. Please set a password using forgot password flow.",
        });
      }

      const isMatch = await user.comparePassword(currentPassword);
      if (!isMatch) {
        return res.status(401).json({ message: "Incorrect current password" });
      }

      user.password = newPassword;
      await user.save();

      res.json({ message: "Password updated successfully" });
    } catch (err) {
      console.error("[ChangePassword] Error:", err);
      res.status(500).json({ message: "Failed to update password" });
    }
  },
);

// Get Login History
router.get("/history", protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("loginHistory");
    res.json({ history: user.loginHistory });
  } catch (err) {
    console.error("[GetHistory] Error:", err);
    res.status(500).json({ message: "Failed to fetch history" });
  }
});

// Get Active Sessions (Mock for now, or based on token logic if using DB sessions)
// Since we use stateless JWT, we can't list all sessions easily without DB tracking.
// We'll return the current session and maybe the history as "sessions".
router.get("/sessions", protect, async (req, res) => {
  // Return last 5 login history entries as "active sessions" for display purposes
  // In a real JWT system, you'd need a whitelist/blacklist table to track active tokens.
  // For now, we'll just show login history as "Recent Activity".
  try {
    const user = await User.findById(req.user.id).select("loginHistory");
    res.json({ sessions: user.loginHistory.slice(0, 5) });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch sessions" });
  }
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
      sendPasswordResetEmail(user.email, user.username, resetLink).catch(
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

      // Invalidate cache
      await cache.del(`user:${user._id}`);

      await session.commitTransaction();
      session.endSession();

      // Send confirmation email (fire and forget)
      sendPasswordChangedEmail(user.email, user.username, {
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

router.delete("/me", authenticate, async (req, res) => {
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

    // Invalidate cache
    await cache.del(`user:${userId}`);

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

    // 4. Send Email (Fire-and-forget)
    sendAccountDeletionEmail(user.email, user.username).catch((err) =>
      console.error(
        `${logPrefix} Failed to send email (non-critical):`,
        err.message,
      ),
    );

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

// --- 2FA Endpoints ---

router.post("/2fa/generate", protect, async (req, res) => {
  try {
    const secret = speakeasy.generateSecret({
      name: `Krypton Drive (${req.user.email})`,
    });
    // Save secret temporarily (or permanently but disabled)
    req.user.twoFactorSecret = secret.base32;
    await req.user.save();

    const url = await qrcode.toDataURL(secret.otpauth_url);
    res.json({ secret: secret.base32, qrCode: url });
  } catch (err) {
    console.error("[2FA Generate] Error:", err);
    res.status(500).json({ message: "Failed to generate 2FA secret" });
  }
});

router.post("/2fa/verify", protect, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ message: "Token required" });

    const user = await User.findById(req.user.id).select("+twoFactorSecret");
    if (!user.twoFactorSecret) {
      return res.status(400).json({ message: "2FA setup not initiated" });
    }

    const verified = speakeasy.totp.verify({
      secret: user.twoFactorSecret,
      encoding: "base32",
      token: token,
    });

    if (verified) {
      user.twoFactorEnabled = true;
      await user.save();
      res.json({ message: "2FA enabled successfully" });
    } else {
      res.status(400).json({ message: "Invalid 2FA code" });
    }
  } catch (err) {
    console.error("[2FA Verify] Error:", err);
    res.status(500).json({ message: "Failed to verify 2FA" });
  }
});

router.post("/2fa/disable", protect, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password)
      return res.status(400).json({ message: "Password required" });

    const user = await User.findById(req.user.id).select("+password");
    if (!(await user.comparePassword(password))) {
      return res.status(401).json({ message: "Incorrect password" });
    }

    user.twoFactorEnabled = false;
    user.twoFactorSecret = undefined;
    await user.save();
    res.json({ message: "2FA disabled successfully" });
  } catch (err) {
    console.error("[2FA Disable] Error:", err);
    res.status(500).json({ message: "Failed to disable 2FA" });
  }
});

export default router;
