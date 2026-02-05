import nodemailer from "nodemailer";
import Redis from "ioredis";
import client from "prom-client";
import { randomUUID } from "crypto";

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
const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const EMAIL_FROM = process.env.EMAIL_FROM_ADDR || SMTP_USER;
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || "Krypton Drive";

// Log Config on Startup (Masking Password)
console.log(
  `[EmailService] Config: Host=${SMTP_HOST}, Port=${SMTP_PORT}, User=${SMTP_USER ? "Set" : "Missing"}, Secure=${SMTP_PORT === 465}`,
);

// --- Redis Setup (Safe Mode) ---
let redis = null;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, {
    lazyConnect: true,
    retryStrategy: (times) => Math.min(times * 50, 2000),
  });
  redis.on("error", (err) =>
    console.warn("[EmailService] Redis Warning (Non-critical):", err.message),
  );
} else {
  console.warn(
    "[EmailService] No REDIS_URL found. Rate limiting & Idempotency disabled (Safe Mode).",
  );
}

// --- Transporter (Updated with IPv4 and Debugging) ---
const transporter = nodemailer.createTransport({
  pool: true,
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465, // true for 465, false for other ports
  auth: { user: SMTP_USER, pass: SMTP_PASS },
  tls: { rejectUnauthorized: false }, // Helps with SSL handshake issues

  // 🔥 FIXES: Force IPv4 and Enable Logs
  family: 4, // Force IPv4 (Fixes Render timeouts)
  logger: true, // Logs SMTP transaction details to console
  debug: true, // Include debug info in logs
  connectionTimeout: 10000, // 10s timeout
});

// --- Helper Functions ---
async function checkRateLimit() {
  if (!redis) return true;
  try {
    const key = `email:rate-limit:${new Date().getMinutes()}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 60);
    return count <= parseInt(process.env.SMTP_RATE_LIMIT_PER_MIN || "100", 10);
  } catch (e) {
    return true;
  }
}

async function checkIdempotency(id) {
  if (!redis || !id) return false;
  try {
    return !!(await redis.get(`email:idempotency:${id}`));
  } catch (e) {
    return false;
  }
}

async function markProcessed(id) {
  if (!redis || !id) return;
  try {
    await redis.set(`email:idempotency:${id}`, "1", "EX", 86400);
  } catch (e) {}
}

// --- Send Email Function ---
async function sendEmail({
  to,
  subject,
  html,
  text,
  userId = "unknown",
  registrationId = "unknown",
}) {
  const jobId = registrationId !== "unknown" ? registrationId : randomUUID();
  const plainText = text || html.replace(/<[^>]*>?/gm, "");

  if (await checkIdempotency(jobId)) return { skipped: true };
  if (!(await checkRateLimit())) throw new Error("Rate limit exceeded");

  let attempt = 0;
  const MAX_RETRIES = 2;

  while (attempt <= MAX_RETRIES) {
    attempt++;
    try {
      console.log(`[Email] Attempt ${attempt} sending to ${to}...`);
      const info = await transporter.sendMail({
        from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
        to,
        subject,
        html,
        text: plainText,
        headers: { "X-Job-ID": jobId },
      });

      emailSendTotal.inc();
      await markProcessed(jobId);
      console.log(
        `[Email] Sent successfully to ${to}. MessageID: ${info.messageId}`,
      );
      return info;
    } catch (err) {
      console.error(`[Email] Attempt ${attempt} failed: ${err.message}`);

      // Log explicit SMTP error details if available
      if (err.command) console.error(`[Email] SMTP Command: ${err.command}`);
      if (err.response) console.error(`[Email] SMTP Response: ${err.response}`);

      if (attempt > MAX_RETRIES) {
        emailFailTotal.inc();
        throw err;
      }
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

// --- Template Wrappers ---
async function sendActivationEmail(to, name, link) {
  return sendEmail({
    to,
    subject: "Activate your Krypton Drive account",
    html: `
      <div style="font-family: Arial, sans-serif; padding: 20px;">
        <h2>Welcome to Krypton Drive, ${name}!</h2>
        <p>Click the button below to activate your account:</p>
        <a href="${link}" style="display: inline-block; padding: 10px 20px; background-color: #4F46E5; color: white; text-decoration: none; border-radius: 5px;">Activate Account</a>
        <p>Or paste this link: ${link}</p>
      </div>`,
    text: `Welcome ${name}! Activate here: ${link}`,
  });
}

async function sendAccountDeletionEmail(to, name) {
  return sendEmail({
    to,
    subject: "Account Deleted - Krypton Drive",
    html: `<p>Goodbye ${name}, your account and data have been permanently deleted.</p>`,
    text: `Goodbye ${name}, account deleted.`,
  });
}

// Stubs
async function sendPasswordResetEmail(to, name, link) {
  return sendEmail({
    to,
    subject: "Reset Password",
    html: `<a href="${link}">Reset</a>`,
    text: link,
  });
}
async function sendPasswordChangedEmail(to, name, data) {
  return sendEmail({
    to,
    subject: "Password Changed",
    html: `<p>Password changed.</p>`,
    text: "Password changed.",
  });
}

export {
  sendEmail,
  sendActivationEmail,
  sendAccountDeletionEmail,
  sendPasswordResetEmail,
  sendPasswordChangedEmail,
};
