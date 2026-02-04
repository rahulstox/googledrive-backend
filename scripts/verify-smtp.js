import "dotenv/config";
import nodemailer from "nodemailer";

async function verifySMTP() {
  console.log("Checking SMTP Configuration...");
  console.log(`Host: ${process.env.SMTP_HOST}`);
  console.log(`Port: ${process.env.SMTP_PORT}`);
  console.log(`Secure: ${process.env.SMTP_SECURE === "true" || process.env.SMTP_PORT === "465"}`);
  console.log(`User: ${process.env.SMTP_USER ? "***" : "Missing"}`);
  console.log(`Pass: ${process.env.SMTP_PASS ? "***" : "Missing"}`);

  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.error("❌ Missing required SMTP environment variables.");
    process.exit(1);
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587", 10),
    secure: process.env.SMTP_SECURE === "true" || process.env.SMTP_PORT === "465",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  try {
    console.log("Verifying connection...");
    await transporter.verify();
    console.log("✅ SMTP Connection Verified Successfully!");
  } catch (error) {
    console.error("❌ SMTP Connection Failed:", error);
    process.exit(1);
  }
}

verifySMTP();
