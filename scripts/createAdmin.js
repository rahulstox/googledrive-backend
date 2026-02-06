import mongoose from "mongoose";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import User from "../src/models/User.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load env vars
dotenv.config({ path: join(__dirname, "../.env") });

const email = process.argv[2];

if (!email) {
  console.error("Please provide an email address as an argument.");
  console.log("Usage: node scripts/createAdmin.js <email>");
  process.exit(1);
}

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("MongoDB Connected");
  } catch (err) {
    console.error("MongoDB connection error:", err);
    process.exit(1);
  }
};

const makeAdmin = async () => {
  await connectDB();

  try {
    const user = await User.findOne({ email });
    if (!user) {
      console.error(`User not found: ${email}`);
      process.exit(1);
    }

    user.role = "admin";
    await user.save();
    console.log(`Successfully promoted ${user.email} to admin.`);
  } catch (err) {
    console.error("Error updating user:", err);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
};

makeAdmin();
