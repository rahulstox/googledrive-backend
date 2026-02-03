import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const EMAIL_FROM = '"Krypton Drive" <no-reply@kryptondrive.com>';

export async function sendActivationEmail(email, firstName, activationLink) {
  await transporter.sendMail({
    from: EMAIL_FROM,
    to: email,
    subject: 'Activate your Krypton Drive account',
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

export async function sendPasswordResetEmail(email, firstName, resetLink) {
  await transporter.sendMail({
    from: EMAIL_FROM,
    to: email,
    subject: 'Reset your Krypton Drive password',
    html: `
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
          <p style="color: #9ca3af; font-size: 12px; margin-top: 24px;">
            This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email.
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
