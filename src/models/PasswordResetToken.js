import mongoose from "mongoose";

const passwordResetSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    tokenHash: {
      type: String,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expireAfterSeconds: 0 }, // TTL index
    },
    consumed: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true },
);

// Compound index for faster lookups if needed, though usually looked up by tokenHash (if unique) or userId
passwordResetSchema.index({ tokenHash: 1 });

export default mongoose.model("PasswordResetToken", passwordResetSchema);
