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

export async function sendActivationEmail(email, firstName, activationLink) {
  await transporter.sendMail({
    from: process.env.EMAIL_FROM || process.env.SMTP_USER,
    to: email,
    subject: 'Activate your account',
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Welcome, ${firstName}!</h2>
        <p>Please click the link below to activate your account:</p>
        <p><a href="${activationLink}" style="background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; display: inline-block;">Activate Account</a></p>
        <p>Or copy this link: ${activationLink}</p>
        <p>This link expires in 24 hours.</p>
      </div>
    `,
  });
}

export async function sendPasswordResetEmail(email, firstName, resetLink) {
  await transporter.sendMail({
    from: process.env.EMAIL_FROM || process.env.SMTP_USER,
    to: email,
    subject: 'Reset your password',
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Hi ${firstName},</h2>
        <p>You requested a password reset. Click the link below to set a new password:</p>
        <p><a href="${resetLink}" style="background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; display: inline-block;">Reset Password</a></p>
        <p>Or copy this link: ${resetLink}</p>
        <p>This link expires in 1 hour. If you didn't request this, ignore this email.</p>
      </div>
    `,
  });
}
