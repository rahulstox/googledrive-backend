import nodemailer from "nodemailer";

// Validate essential configuration
const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;

if (!SMTP_USER || !SMTP_PASS) {
  console.error(
    "[EmailService] CRITICAL: Missing SMTP_USER or SMTP_PASS. Emails will not send.",
  );
}

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465, // true for 465, false for other ports
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS,
  },
});

const EMAIL_FROM = process.env.SMTP_FROM || SMTP_USER;
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || "support@kryptondrive.com";

/**
 * Send an email using Nodemailer (Gmail SMTP)
 * @param {string} to - Recipient email
 * @param {string} subject - Email subject
 * @param {string} html - HTML content
 * @param {string} text - Plain text content (optional)
 * @returns {Promise<object>} - Nodemailer response
 */
async function sendEmail({ to, subject, html, text }) {
  const MAX_RETRIES = 3;
  let attempt = 0;

  while (attempt < MAX_RETRIES) {
    try {
      const info = await transporter.sendMail({
        from: EMAIL_FROM,
        to,
        subject,
        html,
        text: text || html.replace(/<[^>]*>?/gm, ""), // Fallback text generation
      });

      console.log(
        `[EmailService] Email sent to ${to}. MessageId: ${info.messageId} (Attempt ${attempt + 1})`,
      );
      return info;
    } catch (err) {
      attempt++;
      console.error(
        `[EmailService] Attempt ${attempt} failed sending to ${to}: ${err.message}`,
      );

      if (attempt >= MAX_RETRIES) {
        throw new Error(
          `Email Send Failed after ${MAX_RETRIES} attempts: ${err.message}`,
        );
      }

      // Exponential backoff: 1s, 2s, 4s...
      const delay = Math.pow(2, attempt - 1) * 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export async function sendActivationEmail(email, firstName, activationLink) {
  console.log(`[EmailService] Preparing to send activation email to: ${email}`);
  const start = Date.now();
  try {
    const html = `
        <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; background-color: #f9fafb; padding: 40px; border-radius: 12px;">
          <div style="text-align: center; margin-bottom: 32px;">
            <h1 style="color: #111827; margin: 0; font-size: 24px; font-weight: 700;">Krypton Drive</h1>
          </div>
          <div style="background-color: white; padding: 32px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
            <h2 style="color: #1f2937; margin-top: 0; font-size: 20px;">Welcome, ${firstName}!</h2>
            <p style="color: #4b5563; line-height: 1.6; margin-bottom: 24px;">
              Thanks for signing up for Krypton Drive. Please confirm your email address to activate your account and start securing your files.
            </p>
            <div style="text-align: center; margin: 32px 0;">
              <a href="${activationLink}" style="background-color: #2563eb; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; display: inline-block; box-shadow: 0 4px 6px -1px rgba(37, 99, 235, 0.2);">Activate Account</a>
            </div>
            <p style="color: #6b7280; font-size: 14px; line-height: 1.5; margin-bottom: 0;">
              Or copy and paste this link into your browser:<br>
              <a href="${activationLink}" style="color: #2563eb; word-break: break-all;">${activationLink}</a>
            </p>
            <p style="color: #9ca3af; font-size: 12px; margin-top: 24px;">
              This link will expire in 24 hours. If you didn't create an account, you can safely ignore this email.
            </p>
          </div>
          <div style="text-align: center; margin-top: 24px;">
            <p style="color: #9ca3af; font-size: 12px;">
              &copy; ${new Date().getFullYear()} Krypton Drive. All rights reserved.
            </p>
          </div>
        </div>
      `;

    const result = await sendEmail({
      to: email,
      subject: "Activate your Krypton Drive account",
      html,
    });

    console.log(
      `[EmailService] Activation email sent to ${email}. Duration: ${Date.now() - start}ms`,
    );
    return result;
  } catch (error) {
    console.error(
      `[EmailService] Failed to send activation email to ${email}. Duration: ${Date.now() - start}ms. Error: ${error.message}`,
    );
    throw error; // Propagate error for handling in controller
  }
}

export async function sendPasswordResetEmail(email, resetLink) {
  console.log(
    `[EmailService] Preparing to send password reset email to: ${email}`,
  );
  const start = Date.now();
  try {
    const html = `
          <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; background-color: #f9fafb; padding: 40px; border-radius: 12px;">
            <div style="text-align: center; margin-bottom: 32px;">
              <h1 style="color: #111827; margin: 0; font-size: 24px; font-weight: 700;">Krypton Drive</h1>
            </div>
            <div style="background-color: white; padding: 32px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
              <h2 style="color: #1f2937; margin-top: 0; font-size: 20px;">Reset Your Password</h2>
              <p style="color: #4b5563; line-height: 1.6; margin-bottom: 24px;">
                We received a request to reset your password. Click the button below to choose a new one.
              </p>
              <div style="text-align: center; margin: 32px 0;">
                <a href="${resetLink}" style="background-color: #ef4444; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; display: inline-block; box-shadow: 0 4px 6px -1px rgba(239, 68, 68, 0.2);">Reset Password</a>
              </div>
              <p style="color: #6b7280; font-size: 14px; line-height: 1.5; margin-bottom: 0;">
                Or copy and paste this link into your browser:<br>
                <a href="${resetLink}" style="color: #ef4444; word-break: break-all;">${resetLink}</a>
              </p>
              <p style="color: #9ca3af; font-size: 12px; margin-top: 24px;">
                This link will expire in 1 hour. If you didn't request a password reset, you can safely ignore this email.
              </p>
            </div>
            <div style="text-align: center; margin-top: 24px;">
              <p style="color: #9ca3af; font-size: 12px;">
                &copy; ${new Date().getFullYear()} Krypton Drive. All rights reserved.
              </p>
            </div>
          </div>
        `;

    const result = await sendEmail({
      to: email,
      subject: "Reset your Krypton Drive password",
      html,
    });

    console.log(
      `[EmailService] Password reset email sent to ${email}. Duration: ${Date.now() - start}ms`,
    );
    return result;
  } catch (error) {
    console.error(
      `[EmailService] Failed to send password reset email to ${email}. Duration: ${Date.now() - start}ms. Error: ${error.message}`,
    );
    throw error;
  }
}

export async function sendAccountDeletionEmail(email, firstName) {
  console.log(
    `[EmailService] Preparing to send account deletion email to: ${email}`,
  );
  const start = Date.now();
  try {
    const html = `
          <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; background-color: #f9fafb; padding: 40px; border-radius: 12px;">
            <div style="text-align: center; margin-bottom: 32px;">
              <h1 style="color: #111827; margin: 0; font-size: 24px; font-weight: 700;">Krypton Drive</h1>
            </div>
            <div style="background-color: white; padding: 32px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
              <h2 style="color: #1f2937; margin-top: 0; font-size: 20px;">Account Deleted</h2>
              <p style="color: #4b5563; line-height: 1.6; margin-bottom: 24px;">
                Hello ${firstName || "User"},
              </p>
              <p style="color: #4b5563; line-height: 1.6; margin-bottom: 24px;">
                Your account and all associated data have been permanently deleted as per your request.
              </p>
              <p style="color: #4b5563; line-height: 1.6; margin-bottom: 24px;">
                We're sorry to see you go. If you change your mind, you can always create a new account in the future.
              </p>
            </div>
            <div style="text-align: center; margin-top: 24px;">
              <p style="color: #9ca3af; font-size: 12px;">
                &copy; ${new Date().getFullYear()} Krypton Drive. All rights reserved.
              </p>
            </div>
          </div>
        `;

    const result = await sendEmail({
      to: email,
      subject: "Your Krypton Drive account has been deleted",
      html,
    });

    console.log(
      `[EmailService] Account deletion email sent to ${email}. Duration: ${Date.now() - start}ms`,
    );
    return result;
  } catch (error) {
    console.error(
      `[EmailService] Failed to send account deletion email to ${email}. Duration: ${Date.now() - start}ms. Error: ${error.message}`,
    );
    throw error;
  }
}

export async function send2FAEmail(email, code) {
  console.log(`[EmailService] Preparing to send 2FA code to: ${email}`);
  const start = Date.now();
  try {
    const html = `
        <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; background-color: #f9fafb; padding: 40px; border-radius: 12px;">
          <div style="text-align: center; margin-bottom: 32px;">
            <h1 style="color: #111827; margin: 0; font-size: 24px; font-weight: 700;">Krypton Drive</h1>
          </div>
          <div style="background-color: white; padding: 32px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
            <h2 style="color: #1f2937; margin-top: 0; font-size: 20px;">Two-Factor Authentication</h2>
            <p style="color: #4b5563; line-height: 1.6; margin-bottom: 24px;">
              Your verification code is:
            </p>
            <div style="text-align: center; margin: 32px 0;">
              <span style="background-color: #f3f4f6; color: #1f2937; padding: 12px 24px; font-size: 32px; font-family: monospace; letter-spacing: 4px; border-radius: 8px; font-weight: 700; border: 1px solid #e5e7eb;">${code}</span>
            </div>
            <p style="color: #6b7280; font-size: 14px; line-height: 1.5; margin-bottom: 0;">
              This code will expire in 10 minutes. Do not share this code with anyone.
            </p>
          </div>
          <div style="text-align: center; margin-top: 24px;">
            <p style="color: #9ca3af; font-size: 12px;">
              &copy; ${new Date().getFullYear()} Krypton Drive. All rights reserved.
            </p>
          </div>
        </div>
      `;

    const result = await sendEmail({
      to: email,
      subject: "Your 2FA Verification Code",
      html,
    });

    console.log(
      `[EmailService] 2FA email sent to ${email}. Duration: ${Date.now() - start}ms`,
    );
    return result;
  } catch (error) {
    console.error(
      `[EmailService] Failed to send 2FA email to ${email}. Duration: ${Date.now() - start}ms. Error: ${error.message}`,
    );
    throw error;
  }
}

export async function sendPasswordChangedEmail(email, firstName, details) {
  console.log(`[EmailService] Sending password changed notice to: ${email}`);
  const start = Date.now();
  try {
    const html = `
        <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; background-color: #f9fafb; padding: 40px; border-radius: 12px;">
          <div style="text-align: center; margin-bottom: 32px;">
             <h1 style="color: #111827; margin: 0; font-size: 24px; font-weight: 700;">Krypton Drive</h1>
          </div>
          <div style="background-color: white; padding: 32px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
            <h2 style="color: #1f2937; margin-top: 0; font-size: 20px;">Security Alert</h2>
            <p style="color: #4b5563; line-height: 1.6; margin-bottom: 24px;">
              Hello ${firstName || "User"},
            </p>
            <p style="color: #4b5563; line-height: 1.6; margin-bottom: 24px;">
              The password for your Krypton Drive account was successfully changed.
            </p>
            <div style="background-color: #f3f4f6; padding: 16px; border-radius: 8px; margin-bottom: 24px;">
               <p style="margin: 0; color: #4b5563; font-size: 14px;"><strong>Time:</strong> ${details.time}</p>
               <p style="margin: 4px 0 0; color: #4b5563; font-size: 14px;"><strong>IP Address:</strong> ${details.ip}</p>
            </div>
             <p style="color: #4b5563; line-height: 1.6; margin-bottom: 24px;">
              If you did not make this change, please contact support immediately.
            </p>
          </div>
          <div style="text-align: center; margin-top: 24px;">
            <p style="color: #9ca3af; font-size: 12px;">
              &copy; ${new Date().getFullYear()} Krypton Drive. All rights reserved.
            </p>
          </div>
        </div>
      `;

    const result = await sendEmail({
      to: email,
      subject: "Your Krypton Drive password was changed",
      html,
    });
    console.log(
      `[EmailService] Password changed email sent to ${email}. Duration: ${Date.now() - start}ms`,
    );
    return result;
  } catch (error) {
    console.error(
      `[EmailService] Failed to send password changed email to ${email}. Duration: ${Date.now() - start}ms. Error: ${error.message}`,
    );
  }
}
