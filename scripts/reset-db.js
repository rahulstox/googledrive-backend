import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import { cleanDatabase } from "../src/utils/dbCleanup.js";

// Fix for __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env vars
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

async function connectDB() {
  try {
    if (!process.env.MONGODB_URI) {
      throw new Error("MONGODB_URI is not defined in .env");
    }
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("✅ Connected to MongoDB");
  } catch (err) {
    console.error("❌ MongoDB connection error:", err.message);
    process.exit(1);
  }
}

async function runCleanup() {
  await connectDB();

  console.log("\n⚠️  WARNING: THIS ACTION WILL PERMANENTLY DELETE ALL USERS, FILES, AND TOKENS. ⚠️");
  console.log("This is intended for creating a clean testing environment.\n");

  rl.question("Are you sure you want to proceed? Type 'yes' to confirm: ", async (answer) => {
    if (answer.toLowerCase() !== "yes") {
      console.log("Operation cancelled.");
      await mongoose.disconnect();
      process.exit(0);
    }

    console.log("\nStarting cleanup...");

    try {
      const result = await cleanDatabase();
      
      console.log("✅ Cleanup successful!");
      console.log(`- Deleted Users: ${result.userCount}`);
      console.log(`- Deleted Files: ${result.fileCount}`);
      console.log(`- Deleted Tokens: ${result.tokenCount}`);
      
      // Final verification check
      const userCount = await mongoose.model("User").countDocuments();
      if (userCount === 0) {
        console.log("✅ Verification passed: 0 users found in database.");
      } else {
        console.error(`❌ Verification failed: ${userCount} users still exist!`);
      }

    } catch (error) {
      console.error("❌ Cleanup failed:", error.message);
    } finally {
      await mongoose.disconnect();
      rl.close();
      process.exit(0);
    }
  });
}

// Allow skipping prompt with --force
if (process.argv.includes("--force")) {
  (async () => {
    await connectDB();
    try {
      const result = await cleanDatabase();
      console.log("✅ Cleanup successful (force mode)");
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(err);
      process.exit(1);
    } finally {
      await mongoose.disconnect();
      process.exit(0);
    }
  })();
} else {
  runCleanup();
}
