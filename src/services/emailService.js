import nodemailer from "nodemailer";
import Redis from "ioredis";
import client from "prom-client";
import { randomUUID } from "crypto";
import User from "../models/User.js";

// --- Observability ---
const register = client.register;
const getMetric = (name, type, help) => {
  const existing = register.getSingleMetric(name);
  if (existing) return existing;
  return new type({ name, help, registers: [register] });
};
const emailSendTotal = getMetric(
  "email_send_total",
  client.Counter,
  "Total emails sent",
);
const emailFailTotal = getMetric(
  "email_fail_total",
  client.Counter,
  "Total failed emails",
);

// --- Config ---
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || "Krypton Drive";
// Use env var or fallback, but prefer verified domain
const EMAIL_FROM = process.env.EMAIL_FROM_ADDR || "noreply@kryptondrive.com";

// --- Redis Setup (Safe Mode) ---
let redis = null;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, { lazyConnect: true });
  redis.on("error", () => {});
}

// --- Helper: Get Base Template ---
const getBaseTemplate = (content) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Krypton Drive</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f4f4f4; }
    .container { max-width: 600px; margin: 0 auto; background: #ffffff; padding: 0; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.05); }
    .header { background: #2563eb; padding: 20px; text-align: center; }
    .header h1 { color: white; margin: 0; font-size: 24px; font-weight: 600; }
    .content { padding: 30px; }
    .button { display: inline-block; padding: 12px 24px; background-color: #2563eb; color: white !important; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 20px 0; text-align: center; }
    .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; background: #f9fafb; border-top: 1px solid #eee; }
    .link-text { color: #2563eb; word-break: break-all; }
  </style>
</head>
<body>
  <div style="padding: 20px;">
    <div class="container">
      <div class="header">
        <h1>Krypton Drive</h1>
      </div>
      <div class="content">
        ${content}
      </div>
      <div class="footer">
        <p>&copy; ${new Date().getFullYear()} Krypton Drive. All rights reserved.</p>
        <p>If you didn't request this email, you can safely ignore it.</p>
      </div>
    </div>
  </div>
</body>
</html>
`;

// --- Send Email Function (Using Brevo API) ---
async function sendEmail({
  to,
  subject,
  html,
  text,
  category = "transactional",
}) {
  // Check User Preferences for non-transactional emails
  if (category !== "transactional" && category !== "security") {
    try {
      const user = await User.findOne({ email: to }).select("preferences");
      if (
        user &&
        user.preferences &&
        user.preferences.notifications &&
        user.preferences.notifications.email === false
      ) {
        // console.log(`[Email] Skipped sending to ${to} due to user preference.`);
        return { skipped: true, reason: "user_preference" };
      }
    } catch (err) {
      console.warn(
        `[Email] Failed to check preferences for ${to}, sending anyway.`,
        err.message,
      );
    }
  }

  // Brevo API URL
  const url = "https://api.brevo.com/v3/smtp/email";

  const body = {
    sender: { name: EMAIL_FROM_NAME, email: EMAIL_FROM },
    to: [{ email: to }],
    subject: subject,
    htmlContent: html,
    textContent: text || html.replace(/<[^>]*>?/gm, ""),
  };

  // Check for API key
  if (!BREVO_API_KEY) {
    console.warn(
      "[Email] BREVO_API_KEY is missing. Using mock email sender (logging to console).",
    );
    if (text && text.includes("http")) {
      console.log(`[Email] MOCK LINK: ${text.match(/https?:\/\/[^\s]+/)[0]}`);
    }
    // Simulate network delay
    await new Promise((resolve) => setTimeout(resolve, 500));
    emailSendTotal.inc({ status: "mock_success" });
    return { messageId: `mock-${Date.now()}` };
  }

  try {
    // console.log(`[Email] Sending via Brevo API to ${to}...`);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "api-key": BREVO_API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || `Brevo Error: ${response.statusText}`);
    }

    // console.log(`[Email] Sent via Brevo! MessageId: ${data.messageId}`);
    emailSendTotal.inc();
    return data;
  } catch (err) {
    console.error(`[Email] Failed: ${err.message}`);
    emailFailTotal.inc();
    // Fallback log for admin
    if (text && text.includes("http")) {
      console.log(`[Email] MANUAL FALLBACK LINK: ${text}`);
    }
    throw err;
  }
}

// --- Wrappers ---
export const sendActivationEmail = async (to, username, link) => {
  const html = getBaseTemplate(`
    <h2>Welcome, ${username}!</h2>
    <p>Thanks for signing up for Krypton Drive. We're excited to have you on board.</p>
    <p>Please verify your email address to activate your account and start securing your files.</p>
    <div style="text-align: center;">
      <a href="${link}" class="button">Activate Account</a>
    </div>
    <p style="font-size: 14px; margin-top: 20px; color: #666;">Or copy and paste this link into your browser:</p>
    <p><a href="${link}" class="link-text">${link}</a></p>
    <p style="font-size: 14px; color: #666;">This link will expire in 24 hours.</p>
  `);

  const text = `Welcome to Krypton Drive, ${username}!\n\nPlease activate your account by clicking the link below:\n${link}\n\nThis link expires in 24 hours.`;

  return sendEmail({
    to,
    subject: "Action Required: Activate your Krypton Drive account",
    html,
    text,
    category: "transactional",
  });
};

export const sendAccountDeletionEmail = async (to, username) => {
  const html = getBaseTemplate(`
    <h2>Account Deleted</h2>
    <p>Hi ${username},</p>
    <p>Your Krypton Drive account has been successfully deleted.</p>
    <p>We're sorry to see you go. If this was a mistake, please contact support immediately.</p>
  `);

  return sendEmail({
    to,
    subject: "Krypton Drive: Account Deleted",
    html,
    text: `Hi ${username},\n\nYour Krypton Drive account has been deleted. We're sorry to see you go.`,
  });
};

export const sendPasswordResetEmail = async (to, username, link) => {
  const html = getBaseTemplate(`
    <h2>Reset Your Password</h2>
    <p>Hi ${username},</p>
    <p>We received a request to reset the password for your Krypton Drive account.</p>
    <div style="text-align: center;">
      <a href="${link}" class="button">Reset Password</a>
    </div>
    <p style="font-size: 14px; margin-top: 20px; color: #666;">Or copy and paste this link into your browser:</p>
    <p><a href="${link}" class="link-text">${link}</a></p>
    <p style="font-size: 14px; color: #666;">This link will expire in 1 hour. If you didn't ask for this, you can ignore this email.</p>
  `);

  const text = `Hi ${username},\n\nReset your password by clicking the link below:\n${link}\n\nThis link expires in 1 hour.`;

  return sendEmail({
    to,
    subject: "Action Required: Reset your Krypton Drive password",
    html,
    text,
  });
};

export const sendPasswordChangedEmail = async (to, username, details = {}) => {
  const { time, ip, userAgent } = details;

  const html = getBaseTemplate(`
    <h2>Password Changed</h2>
    <p>Hi ${username},</p>
    <p>This is a confirmation that the password for your Krypton Drive account has just been changed.</p>
    <div style="background: #f9fafb; padding: 15px; border-radius: 6px; margin: 20px 0; font-size: 14px; color: #555;">
      <p style="margin: 5px 0;"><strong>Time:</strong> ${time || "Just now"}</p>
      <p style="margin: 5px 0;"><strong>IP Address:</strong> ${ip || "Unknown"}</p>
      <p style="margin: 5px 0;"><strong>Device:</strong> ${userAgent || "Unknown"}</p>
    </div>
    <p>If you didn't change your password, please contact our support team immediately.</p>
  `);

  const text = `Hi ${username},\n\nThis is a confirmation that the password for your Krypton Drive account has just been changed.\n\nTime: ${time || "Just now"}\nIP Address: ${ip || "Unknown"}\nDevice: ${userAgent || "Unknown"}\n\nIf you didn't change your password, please contact our support team immediately.`;

  return sendEmail({
    to,
    subject: "Security Alert: Password Changed",
    html,
    text,
    category: "security",
  });
};

export const sendNotificationEmail = async (to, subject, html, text) => {
  return sendEmail({
    to,
    subject,
    html,
    text,
    category: "notification",
  });
};
