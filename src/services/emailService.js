import nodemailer from "nodemailer";
import Redis from "ioredis";
import client from "prom-client";
import { randomUUID } from "crypto";

// --- Observability: Prometheus Metrics ---
const register = client.register;

// Check if metrics already exist to prevent re-registration errors during hot reload/tests
const getMetric = (name, type, help) => {
  const existing = register.getSingleMetric(name);
  if (existing) return existing;
  const metric = new type({ name, help, registers: [register] });
  return metric;
};

const emailSendTotal = getMetric(
  "email_send_total",
  client.Counter,
  "Total number of email send attempts",
);
const emailRetryTotal = getMetric(
  "email_retry_total",
  client.Counter,
  "Total number of email retries",
);
const emailFailTotal = getMetric(
  "email_fail_total",
  client.Counter,
  "Total number of failed email sends",
);
const emailDuration = getMetric(
  "email_duration_seconds",
  client.Histogram,
  "Duration of email sending in seconds",
);

// --- Configuration ---
const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_POOL_MAX_CONNECTIONS = parseInt(
  process.env.SMTP_POOL_MAX_CONNECTIONS || "5",
  10,
);
const SMTP_POOL_MAX_MESSAGES = parseInt(
  process.env.SMTP_POOL_MAX_MESSAGES || "100",
  10,
);
const SMTP_RATE_LIMIT_PER_MIN = parseInt(
  process.env.SMTP_RATE_LIMIT_PER_MIN || "100",
  10,
);
const EMAIL_FROM =
  process.env.EMAIL_FROM_ADDR || SMTP_USER || "noreply@kryptondrive.com";
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || "Krypton Drive";
const DOMAIN_URL = process.env.DOMAIN_URL || "http://localhost:5173";

// --- Redis Client (for Idempotency & Rate Limiting) ---
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
  lazyConnect: true,
  retryStrategy: (times) => Math.min(times * 50, 2000),
});

redis.on("error", (err) => {
  console.warn("[EmailService] Redis connection error:", err.message);
  // We continue; logic should degrade gracefully if Redis is down
});

// --- Nodemailer Transporter (Pooled) ---
if (!SMTP_USER || !SMTP_PASS) {
  console.error(
    "[EmailService] CRITICAL: Missing SMTP_USER or SMTP_PASS. Emails will not send.",
  );
}

const transporter = nodemailer.createTransport({
  pool: true,
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465, // true for 465, false for other ports
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS,
  },
  maxConnections: SMTP_POOL_MAX_CONNECTIONS,
  maxMessages: SMTP_POOL_MAX_MESSAGES,
  tls: {
    rejectUnauthorized: true, // Enforce valid certs (Production Grade)
    minVersion: "TLSv1.2", // Enforce strong TLS
  },
  // Default connection timeout
  connectionTimeout: 10000,
  greetingTimeout: 5000,
  socketTimeout: 10000,
});

/**
 * Structured Log Helper
 */
function logEvent(event, data) {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      service: "email-service",
      event,
      ...data,
    }),
  );
}

/**
 * Rate Limiter (Token Bucket approx using Redis)
 * @returns {Promise<boolean>} true if allowed, false if limited
 */
async function checkRateLimit() {
  try {
    const key = `email:rate-limit:${new Date().getMinutes()}`;
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, 60); // Expire after 1 minute
    }
    return count <= SMTP_RATE_LIMIT_PER_MIN;
  } catch (err) {
    // If Redis fails, allow traffic to avoid blocking critical emails
    console.warn(
      "[EmailService] Rate limit check failed (Redis down), allowing.",
      err.message,
    );
    return true;
  }
}

/**
 * Idempotency Check
 * @param {string} id - Unique Job ID
 * @returns {Promise<boolean>} true if already processed
 */
async function checkIdempotency(id) {
  if (!id) return false;
  try {
    const key = `email:idempotency:${id}`;
    const exists = await redis.get(key);
    return !!exists;
  } catch (err) {
    return false;
  }
}

/**
 * Mark Job as Processed
 * @param {string} id
 */
async function markProcessed(id) {
  if (!id) return;
  try {
    const key = `email:idempotency:${id}`;
    await redis.set(key, "1", "EX", 86400); // 24 hours retention
  } catch (err) {
    console.warn("[EmailService] Failed to set idempotency key:", err.message);
  }
}

/**
 * Send Email with Retry, Idempotency, and Monitoring
 * @param {object} options - { to, subject, html, text, userId, registrationId }
 */
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

  // 1. Idempotency Check
  if (await checkIdempotency(jobId)) {
    logEvent("email_skipped_idempotent", { jobId, userId, to });
    return { skipped: true, message: "Already processed" };
  }

  // 2. Rate Limiting
  if (!(await checkRateLimit())) {
    logEvent("email_rate_limited", { jobId, userId, to });
    emailFailTotal.inc();
    throw new Error("Email rate limit exceeded. Please try again later.");
  }

  const endTimer = emailDuration.startTimer();
  let attempt = 0;
  const MAX_RETRIES = 5;

  // 3. Retry Loop
  while (attempt <= MAX_RETRIES) {
    attempt++;
    emailSendTotal.inc();

    try {
      const info = await transporter.sendMail({
        from: `"${EMAIL_FROM_NAME}" <${EMAIL_FROM}>`,
        to,
        subject,
        html,
        text: plainText,
        headers: {
          "X-Entity-Ref-ID": userId,
          "X-Job-ID": jobId,
          "List-Unsubscribe": `<${DOMAIN_URL}/unsubscribe?email=${to}>`,
          Precedence: "bulk",
        },
      });

      logEvent("email_sent_success", {
        jobId,
        userId,
        to,
        messageId: info.messageId,
        attempt,
      });

      await markProcessed(jobId);
      endTimer();
      return info;
    } catch (err) {
      const isTransient =
        err.responseCode &&
        err.responseCode >= 400 &&
        err.responseCode < 500 &&
        err.responseCode !== 403; // 4xx are usually transient, except 403 (Auth)

      // Treat some 5xx as permanent (e.g., 550 User not found), but for now we focus on connection issues
      // Hard failure if auth fails (535) or strictly fatal
      if (err.responseCode === 535) {
        logEvent("email_auth_failed", { jobId, userId, error: err.message });
        emailFailTotal.inc();
        endTimer();
        throw err; // Don't retry auth failures
      }

      logEvent("email_send_failed", {
        jobId,
        userId,
        attempt,
        error: err.message,
        responseCode: err.responseCode,
      });

      if (attempt > MAX_RETRIES) {
        emailFailTotal.inc();
        endTimer();
        throw new Error(
          `Email failed after ${MAX_RETRIES} attempts: ${err.message}`,
        );
      }

      // Exponential Backoff: 2s, 4s, 8s, 16s, 32s
      const delay = Math.pow(2, attempt) * 1000;
      emailRetryTotal.inc();

      logEvent("email_retry_scheduled", {
        jobId,
        userId,
        delayMs: delay,
        nextAttempt: attempt + 1,
      });

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Convenience method for activation emails
 */
async function sendActivationEmail(to, name, link) {
  const subject = "Activate your Krypton Drive account";
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>Welcome to Krypton Drive, ${name}!</h2>
      <p>Please click the button below to verify your email address and activate your account.</p>
      <div style="text-align: center; margin: 30px 0;">
        <a href="${link}" style="background-color: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold;">Activate Account</a>
      </div>
      <p>This link will expire in 24 hours.</p>
      <p style="color: #666; font-size: 12px; margin-top: 50px;">If you didn't create an account, you can safely ignore this email.</p>
    </div>
  `;
  const text = `Welcome to Krypton Drive, ${name}!\n\nPlease visit the following link to activate your account:\n${link}\n\nThis link will expire in 24 hours.`;

  return sendEmail({ to, subject, html, text });
}

/**
 * Send Password Reset Email
 */
async function sendPasswordResetEmail(to, name, link) {
  const subject = "Reset your Krypton Drive password";
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>Hello ${name},</h2>
      <p>You requested a password reset. Please click the button below to set a new password:</p>
      <div style="text-align: center; margin: 30px 0;">
        <a href="${link}" style="background-color: #EF4444; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold;">Reset Password</a>
      </div>
      <p>This link will expire in 15 minutes.</p>
      <p style="color: #666; font-size: 12px; margin-top: 50px;">If you didn't request this, please ignore this email or contact support if you have concerns.</p>
    </div>
  `;
  const text = `Hello ${name},\n\nYou requested a password reset. Please visit the following link to set a new password:\n${link}\n\nThis link will expire in 15 minutes.\n\nIf you didn't request this, please ignore this email.`;

  return sendEmail({ to, subject, html, text });
}

/**
 * Send Password Changed Notification
 */
async function sendPasswordChangedEmail(to, name, { time, ip, userAgent }) {
  const subject = "Your Krypton Drive password has been changed";
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>Hello ${name},</h2>
      <p>Your password was successfully changed.</p>
      <div style="background-color: #f3f4f6; padding: 15px; border-radius: 4px; margin: 20px 0;">
        <p style="margin: 5px 0;"><strong>Time:</strong> ${time}</p>
        <p style="margin: 5px 0;"><strong>IP Address:</strong> ${ip}</p>
        <p style="margin: 5px 0;"><strong>Device:</strong> ${userAgent}</p>
      </div>
      <p>If this wasn't you, please contact support immediately.</p>
    </div>
  `;
  const text = `Hello ${name},\n\nYour password was successfully changed.\n\nTime: ${time}\nIP Address: ${ip}\nDevice: ${userAgent}\n\nIf this wasn't you, please contact support immediately.`;

  return sendEmail({ to, subject, html, text });
}

/**
 * Send Account Deletion Confirmation
 */
async function sendAccountDeletionEmail(to, name) {
  const subject = "Your Krypton Drive account has been deleted";
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>Goodbye ${name},</h2>
      <p>Your account and all associated data have been permanently deleted as requested.</p>
      <p>We're sorry to see you go. If you change your mind, you're always welcome to create a new account.</p>
    </div>
  `;
  const text = `Goodbye ${name},\n\nYour account and all associated data have been permanently deleted as requested.\n\nWe're sorry to see you go.`;

  return sendEmail({ to, subject, html, text });
}

export {
  sendEmail,
  sendActivationEmail,
  sendPasswordResetEmail,
  sendPasswordChangedEmail,
  sendAccountDeletionEmail,
};
