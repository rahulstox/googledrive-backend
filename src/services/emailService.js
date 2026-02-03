import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || "587", 10),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const EMAIL_FROM = '"Krypton Drive" <no-reply@kryptondrive.com>';
const SUPPORT_EMAIL = "support@kryptondrive.com";

export async function sendActivationEmail(email, firstName, activationLink) {
  // Existing implementation...
  await transporter.sendMail({
    from: EMAIL_FROM,
    to: email,
    subject: "Activate your Krypton Drive account",
    html: `
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
    `,
  });
}

export async function sendPasswordResetEmail(
  email,
  firstName,
  resetLink,
  expiryMinutes = 15,
) {
  const expiryText = `${expiryMinutes} minutes`;
  const htmlContent = `
    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; background-color: #f9fafb; padding: 40px; border-radius: 12px;">
      <div style="text-align: center; margin-bottom: 32px;">
        <h1 style="color: #111827; margin: 0; font-size: 24px; font-weight: 700;">Krypton Drive</h1>
      </div>
      <div style="background-color: white; padding: 32px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
        <h2 style="color: #1f2937; margin-top: 0; font-size: 20px;">Hi ${firstName},</h2>
        <p style="color: #4b5563; line-height: 1.6; margin-bottom: 24px;">
          We received a request to reset your password. Click the button below to choose a new password.
        </p>
        <div style="text-align: center; margin: 32px 0;">
          <a href="${resetLink}" style="background-color: #2563eb; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; display: inline-block; box-shadow: 0 4px 6px -1px rgba(37, 99, 235, 0.2);">Reset Password</a>
        </div>
        <p style="color: #6b7280; font-size: 14px; line-height: 1.5; margin-bottom: 0;">
          Or copy and paste this link into your browser:<br>
          <a href="${resetLink}" style="color: #2563eb; word-break: break-all;">${resetLink}</a>
        </p>
        <p style="color: #4b5563; font-size: 14px; line-height: 1.6; margin-top: 24px;">
          This link expires in <strong>${expiryText}</strong>. If you didn't request a password reset, you can safely ignore this email.
        </p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
        <p style="color: #9ca3af; font-size: 12px;">
          Need help? Contact <a href="mailto:${SUPPORT_EMAIL}" style="color: #6b7280; text-decoration: underline;">${SUPPORT_EMAIL}</a>
        </p>
      </div>
      <div style="text-align: center; margin-top: 24px;">
        <p style="color: #9ca3af; font-size: 12px;">
          &copy; ${new Date().getFullYear()} Krypton Drive. All rights reserved.
        </p>
        <p style="color: #9ca3af; font-size: 12px;">
          <a href="#" style="color: #9ca3af; text-decoration: underline;">Unsubscribe</a> from these alerts.
        </p>
      </div>
    </div>
  `;

  const textContent = `
    Hi ${firstName},

    We received a request to reset your password.
    
    Please visit the following link to choose a new password:
    ${resetLink}

    This link expires in ${expiryText}.
    
    If you didn't request a password reset, you can safely ignore this email.

    Need help? Contact ${SUPPORT_EMAIL}
  `;

  await transporter.sendMail({
    from: EMAIL_FROM,
    to: email,
    subject: "Reset your Krypton Drive password",
    text: textContent,
    html: htmlContent,
    list: {
      unsubscribe: {
        url: `${process.env.FRONTEND_URL || "http://localhost:5173"}/unsubscribe`,
        comment: "One-Click Unsubscribe",
      },
    },
  });
}

export async function sendPasswordChangedEmail(
  email,
  firstName,
  metadata = {},
) {
  const { time, ip, userAgent } = metadata;
  const htmlContent = `
    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; background-color: #f9fafb; padding: 40px; border-radius: 12px;">
      <div style="text-align: center; margin-bottom: 32px;">
        <h1 style="color: #111827; margin: 0; font-size: 24px; font-weight: 700;">Krypton Drive</h1>
      </div>
      <div style="background-color: white; padding: 32px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
        <h2 style="color: #1f2937; margin-top: 0; font-size: 20px;">Hi ${firstName},</h2>
        <p style="color: #4b5563; line-height: 1.6; margin-bottom: 24px;">
          Your password was successfully changed.
        </p>
        <div style="background-color: #f3f4f6; padding: 16px; border-radius: 8px; margin-bottom: 24px;">
          <p style="margin: 0; font-size: 13px; color: #4b5563;"><strong>Time:</strong> ${time}</p>
          <p style="margin: 8px 0 0; font-size: 13px; color: #4b5563;"><strong>IP Address:</strong> ${ip}</p>
          <p style="margin: 8px 0 0; font-size: 13px; color: #4b5563;"><strong>Device:</strong> ${userAgent}</p>
        </div>
        <p style="color: #4b5563; line-height: 1.6;">
          If you did not make this change, please <a href="mailto:${SUPPORT_EMAIL}" style="color: #dc2626; font-weight: 600;">contact support immediately</a>.
        </p>
      </div>
      <div style="text-align: center; margin-top: 24px;">
        <p style="color: #9ca3af; font-size: 12px;">
          &copy; ${new Date().getFullYear()} Krypton Drive. All rights reserved.
        </p>
      </div>
    </div>
  `;

  await transporter.sendMail({
    from: EMAIL_FROM,
    to: email,
    subject: "Your Krypton Drive password was changed",
    html: htmlContent,
  });
}

export async function sendAccountDeletionEmail(email, firstName) {
  await transporter.sendMail({
    from: EMAIL_FROM,
    to: email,
    subject: "Your Krypton Drive account has been deleted",
    html: `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; background-color: #f9fafb; padding: 40px; border-radius: 12px;">
        <div style="text-align: center; margin-bottom: 32px;">
          <h1 style="color: #111827; margin: 0; font-size: 24px; font-weight: 700;">Krypton Drive</h1>
        </div>
        <div style="background-color: white; padding: 32px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
          <h2 style="color: #1f2937; margin-top: 0; font-size: 20px;">Goodbye, ${firstName}</h2>
          <p style="color: #4b5563; line-height: 1.6; margin-bottom: 24px;">
            Your account and all associated data have been permanently deleted as per your request.
          </p>
          <p style="color: #4b5563; line-height: 1.6; margin-bottom: 24px;">
            We're sorry to see you go. If you change your mind, you are always welcome to create a new account.
          </p>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
          <p style="color: #9ca3af; font-size: 12px;">
            If you did not request this deletion, please contact <a href="mailto:${SUPPORT_EMAIL}" style="color: #6b7280; text-decoration: underline;">${SUPPORT_EMAIL}</a> immediately.
          </p>
        </div>
        <div style="text-align: center; margin-top: 24px;">
          <p style="color: #9ca3af; font-size: 12px;">
            &copy; ${new Date().getFullYear()} Krypton Drive. All rights reserved.
          </p>
        </div>
      </div>
    `,
  });
}
