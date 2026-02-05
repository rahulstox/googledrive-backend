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
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || "Krypton Drive";
const EMAIL_FROM = "ecopackai@gmail.com"; // Zaroori: Ye wahi email hona chahiye jo Brevo pe verify kiya hai

// --- Redis Setup (Safe Mode) ---
let redis = null;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, { lazyConnect: true });
  redis.on("error", () => {});
}

// --- Send Email Function (Using Brevo API) ---
async function sendEmail({ to, subject, html, text }) {
  // Brevo API URL
  const url = "https://api.brevo.com/v3/smtp/email";

  const body = {
    sender: { name: EMAIL_FROM_NAME, email: EMAIL_FROM },
    to: [{ email: to }],
    subject: subject,
    htmlContent: html,
    textContent: text || html.replace(/<[^>]*>?/gm, ""),
  };

  try {
    console.log(`[Email] Sending via Brevo API to ${to}...`);

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

    console.log(`[Email] Sent via Brevo! MessageId: ${data.messageId}`);
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
export const sendActivationEmail = async (to, name, link) =>
  sendEmail({
    to,
    subject: "Activate your Krypton Drive account",
    html: `<h2>Welcome ${name}!</h2><p>Click <a href="${link}">here</a> to activate.</p>`,
    text: `Welcome ${name}! Link: ${link}`,
  });

export const sendAccountDeletionEmail = async (to, name) =>
  sendEmail({
    to,
    subject: "Account Deleted",
    html: "<p>Account deleted.</p>",
    text: "Account deleted.",
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
    html: "<p>Password changed.</p>",
    text: "Password changed.",
  });
