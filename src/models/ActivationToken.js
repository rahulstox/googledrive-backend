import mongoose from "mongoose";

const activationTokenSchema = new mongoose.Schema(
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
      index: { expireAfterSeconds: 0 }, // TTL index for auto-deletion
    },
  },
  { timestamps: true }
);

// Index for fast lookups
activationTokenSchema.index({ tokenHash: 1 });
activationTokenSchema.index({ userId: 1 });

export default mongoose.model("ActivationToken", activationTokenSchema);
