import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      unique: true,
      lowercase: true,
      trim: true,
      match: [
        /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}))$/,
        "Please provide a valid email address",
      ],
      sparse: true,
    },
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      match: [
        /^[A-Za-z0-9_-]{3,20}$/,
        "Username must be 3-20 characters and can only contain letters, numbers, underscores, and hyphens",
      ],
    },
    bio: {
      type: String,
      maxlength: [500, "Bio cannot exceed 500 characters"],
      default: "",
    },
    avatarUrl: {
      type: String,
      default: "",
    },
    phoneNumber: {
      type: String,
      unique: true,
      sparse: true,
    },
    password: {
      type: String,
      minlength: [8, "Password must be at least 8 characters"],
      select: false,
    },
    googleId: { type: String, unique: true, sparse: true },
    githubId: { type: String, unique: true, sparse: true },
    authProvider: {
      type: String,
      enum: ["email", "google", "github", "phone"],
      default: "email",
    },
    isActive: {
      type: Boolean,
      default: false, // Default to false for security
    },
    role: {
      type: String,
      enum: ["user", "admin"],
      default: "user",
    },
    activationToken: {
      type: String,
      select: false,
    },
    activationTokenExpires: {
      type: Date,
      select: false,
    },
    tokenVersion: {
      type: Number,
      default: 0,
      select: false,
    },
    trashRetentionDays: {
      type: Number,
      default: 30,
      min: 1,
      max: 365,
    },
    storageUsed: {
      type: Number,
      default: 0,
      min: 0,
    },
    storageLimit: {
      type: Number,
      default: 1073741824, // 1GB in bytes
      min: 0,
    },
    // Settings & Preferences
    preferences: {
      language: { type: String, default: "en" },
      timezone: { type: String, default: "UTC" },
      theme: {
        type: String,
        enum: ["light", "dark", "system"],
        default: "system",
      },
      notifications: {
        email: { type: Boolean, default: true },
        push: { type: Boolean, default: true },
        sms: { type: Boolean, default: false },
      },
      privacy: {
        profileVisibility: {
          type: String,
          enum: ["public", "private", "contacts"],
          default: "public",
        },
        showActivityStatus: { type: Boolean, default: true },
      },
    },
    // Security
    twoFactorEnabled: { type: Boolean, default: false },
    twoFactorSecret: { type: String, select: false },
    loginHistory: [
      {
        timestamp: { type: Date, default: Date.now },
        ip: String,
        device: String,
        location: String,
      },
    ],
  },
  { timestamps: true },
);

// Composite indexes for performance
userSchema.index({ email: 1, isActive: 1 });

userSchema.pre("save", async function (next) {
  if (!this.isModified("password") || !this.password) return next();
  const salt = await bcrypt.genSalt(12); // Increased to 12 for better security
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

userSchema.methods.comparePassword = async function (candidatePassword) {
  if (!this.password) return false;
  return bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.getSignedJwtToken = function () {
  return jwt.sign(
    { id: this._id, v: this.tokenVersion },
    process.env.JWT_SECRET,
    {
      expiresIn: process.env.JWT_EXPIRE || "7d",
    },
  );
};

export default mongoose.model("User", userSchema);
