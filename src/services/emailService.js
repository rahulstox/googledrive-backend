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

// --- Transporter ---
const transporter = nodemailer.createTransport({
  pool: true,
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465, // true for 465, false for other ports
  auth: { user: SMTP_USER, pass: SMTP_PASS },
  tls: { rejectUnauthorized: false }, // Helps with some Render/SSL handshake issues
});

// --- Helper Functions ---
async function checkRateLimit() {
  if (!redis) return true; // Bypass if no Redis
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
  const MAX_RETRIES = 2; // Reduced retries for faster feedback

  while (attempt <= MAX_RETRIES) {
    attempt++;
    try {
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
      console.log(`[Email] Sent to ${to}`);
      return info;
    } catch (err) {
      console.error(`[Email] Attempt ${attempt} failed: ${err.message}`);
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
    html: `<h2>Welcome ${name}!</h2><p>Click <a href="${link}">here</a> to activate your account.</p>`,
    text: `Welcome ${name}! Link: ${link}`,
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

// Stubs for other emails
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
