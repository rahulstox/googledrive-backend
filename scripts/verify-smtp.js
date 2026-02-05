import nodemailer from "nodemailer";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// Fix for __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env vars from root .env BEFORE importing services
dotenv.config({ path: path.resolve(__dirname, "../.env") });

// Import services dynamically to ensure env vars are loaded
const { sendActivationEmail, send2FAEmail } =
  await import("../src/services/emailService.js");

console.log("🔍 Starting Comprehensive SMTP Verification & Delivery Test...");

const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const TARGET_EMAIL = "rahulmath9444@gmail.com"; // Specific target for 2FA test

console.log(`\n📋 Configuration Check:`);
console.log(`- Host: ${SMTP_HOST}`);
console.log(`- Port: ${SMTP_PORT}`);
console.log(
  `- User: ${SMTP_USER ? "******" + SMTP_USER.slice(-4) : "MISSING"}`,
);
console.log(`- Pass: ${SMTP_PASS ? "******" : "MISSING"}`);
console.log(`- Target: ${TARGET_EMAIL}`);

if (!SMTP_USER || !SMTP_PASS) {
  console.error("❌ CRITICAL: SMTP_USER or SMTP_PASS is missing in .env");
  process.exit(1);
}

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465,
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS,
  },
});

async function runTests() {
  const results = {
    connection: false,
    activationEmail: false,
    twoFactorEmail: false,
    errors: [],
  };

  try {
    // 1. Verify Connection
    console.log("\n1️⃣  Testing SMTP Connection...");
    const connStart = Date.now();
    await transporter.verify();
    const connDuration = Date.now() - connStart;
    console.log(`✅ Connection Successful! (${connDuration}ms)`);
    results.connection = true;

    // 2. Test User Validation Email (Activation)
    console.log(
      `\n2️⃣  Testing User Validation Email Delivery to ${TARGET_EMAIL}...`,
    );
    try {
      const actStart = Date.now();
      await sendActivationEmail(
        TARGET_EMAIL,
        "Rahul (Test)",
        "https://kryptondrive.com/activate/test-token-123",
      );
      const actDuration = Date.now() - actStart;
      console.log(`✅ Activation Email Sent Successfully! (${actDuration}ms)`);
      results.activationEmail = true;
    } catch (err) {
      console.error(`❌ Activation Email Failed: ${err.message}`);
      results.errors.push(`Activation Email: ${err.message}`);
    }

    // 3. Test 2FA Email (Specific Requirement)
    console.log(`\n3️⃣  Testing 2FA Email Delivery to ${TARGET_EMAIL}...`);
    try {
      const twoFaStart = Date.now();
      const testCode = "123456";
      await send2FAEmail(TARGET_EMAIL, testCode);
      const twoFaDuration = Date.now() - twoFaStart;
      console.log(`✅ 2FA Email Sent Successfully! (${twoFaDuration}ms)`);
      results.twoFactorEmail = true;
    } catch (err) {
      console.error(`❌ 2FA Email Failed: ${err.message}`);
      results.errors.push(`2FA Email: ${err.message}`);
    }
  } catch (error) {
    console.error("\n❌ Fatal Error during verification:", error.message);
    results.errors.push(`Fatal: ${error.message}`);
  }

  // Final Report
  console.log("\n" + "=".repeat(50));
  console.log("📊 FINAL TEST REPORT");
  console.log("=".repeat(50));
  console.log(
    `SMTP Connection:      ${results.connection ? "✅ PASS" : "❌ FAIL"}`,
  );
  console.log(
    `User Validation Email: ${results.activationEmail ? "✅ PASS" : "❌ FAIL"}`,
  );
  console.log(
    `2FA Email (Specific):  ${results.twoFactorEmail ? "✅ PASS" : "❌ FAIL"}`,
  );

  if (results.errors.length > 0) {
    console.log("\nErrors Encountered:");
    results.errors.forEach((e) => console.log(`- ${e}`));
    process.exit(1);
  } else {
    console.log("\n✅ All systems operational. Email delivery verified.");
    process.exit(0);
  }
}

runTests();
