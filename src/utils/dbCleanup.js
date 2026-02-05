import mongoose from "mongoose";
import User from "../models/User.js";
import File from "../models/File.js";
import PasswordResetToken from "../models/PasswordResetToken.js";

/**
 * Clears all user-related data from the database.
 * Uses a transaction to ensure atomicity.
 * 
 * @returns {Promise<{ userCount: number, fileCount: number, tokenCount: number }>} - Counts of deleted documents.
 * @throws {Error} - If deletion fails.
 */
export const cleanDatabase = async () => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // 1. Delete all PasswordResetTokens (depend on Users)
    const { deletedCount: tokenCount } = await PasswordResetToken.deleteMany({}).session(session);

    // 2. Delete all Files (depend on Users)
    const { deletedCount: fileCount } = await File.deleteMany({}).session(session);

    // 3. Delete all Users
    const { deletedCount: userCount } = await User.deleteMany({}).session(session);

    // 4. Verify deletion
    const remainingUsers = await User.countDocuments().session(session);
    if (remainingUsers > 0) {
      throw new Error(`Verification failed: ${remainingUsers} users remain after deletion.`);
    }

    await session.commitTransaction();

    return { userCount, fileCount, tokenCount };
  } catch (error) {
    await session.abortTransaction();
    console.error("❌ Database cleanup failed. Transaction aborted.", error);
    throw error;
  } finally {
    session.endSession();
  }
};
