import nodemailer from "nodemailer";
import { Resend } from "resend";
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
// Priority: Resend > Gmail SMTP
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const EMAIL_FROM = process.env.EMAIL_FROM_ADDR || "onboarding@resend.dev";
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || "Krypton Drive";

// --- Clients ---
let resend = null;
if (RESEND_API_KEY) {
  resend = new Resend(RESEND_API_KEY);
  console.log(
    "[EmailService] 🚀 Resend API Initialized (Bypassing SMTP Ports)",
  );
} else {
  console.warn(
    "[EmailService] ⚠️ RESEND_API_KEY missing. Fallback to SMTP (May fail on Render Free Tier)",
  );
}

const transporter = nodemailer.createTransport({
  pool: true,
  host: SMTP_HOST,
  port: 465,
  secure: true,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
  tls: { rejectUnauthorized: false },
});

// --- Redis ---
let redis = null;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, { lazyConnect: true });
  redis.on("error", () => {});
}

// --- Send Function (Hybrid Strategy) ---
async function sendEmail({ to, subject, html, text }) {
  const plainText = text || html.replace(/<[^>]*>?/gm, "");

  // 1. First Choice: Resend API (HTTP - Works on Render Free)
  if (resend) {
    try {
      console.log(`[Email] Sending via Resend to ${to}...`);
      const data = await resend.emails.send({
        from: `${EMAIL_FROM_NAME} <${EMAIL_FROM}>`,
        to,
        subject,
        html,
        text: plainText,
      });
      if (data.error) throw new Error(data.error.message);

      console.log(`[Email] Sent via Resend! ID: ${data.data.id}`);
      emailSendTotal.inc();
      return data;
    } catch (err) {
      console.error(`[Email] Resend Failed: ${err.message}. Trying SMTP...`);
    }
  }

  // 2. Second Choice: Gmail SMTP (Will try if Resend fails/missing)
  try {
    console.log(`[Email] Sending via SMTP to ${to}...`);
    const info = await transporter.sendMail({
      from: `"${EMAIL_FROM_NAME}" <${SMTP_USER}>`,
      to,
      subject,
      html,
      text: plainText,
    });
    console.log(`[Email] Sent via SMTP! ID: ${info.messageId}`);
    emailSendTotal.inc();
    return info;
  } catch (err) {
    console.error(`[Email] All methods failed for ${to}: ${err.message}`);
    emailFailTotal.inc();
    throw err;
  }
}

// --- Wrappers ---
export const sendActivationEmail = async (to, name, link) =>
  sendEmail({
    to,
    subject: "Activate Account",
    html: `<a href="${link}">Activate</a>`,
    text: link,
  });

export const sendAccountDeletionEmail = async (to, name) =>
  sendEmail({
    to,
    subject: "Account Deleted",
    html: "<p>Deleted</p>",
    text: "Deleted",
  });

export const sendPasswordResetEmail = async (to, name, link) =>
  sendEmail({
    to,
    subject: "Reset Password",
    html: `<a href="${link}">Reset</a>`,
    text: link,
  });

export const sendPasswordChangedEmail = async (to, name) =>
  sendEmail({
    to,
    subject: "Password Changed",
    html: "<p>Changed</p>",
    text: "Changed",
  });
