import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import nodemailer from "nodemailer";

// Hoist the mock function so it can be used in vi.mock
const { sendMailMock } = vi.hoisted(() => {
  return { sendMailMock: vi.fn() };
});

// Mock Nodemailer
vi.mock("nodemailer", () => {
  return {
    default: {
      createTransport: vi.fn(() => ({
        sendMail: sendMailMock,
      })),
    },
  };
});

describe("Email Service (Nodemailer)", () => {
  let emailService;

  beforeEach(async () => {
    vi.resetModules();
    process.env.SMTP_HOST = "smtp.test.com";
    process.env.SMTP_PORT = "587";
    process.env.SMTP_USER = "test@krypton.com";
    process.env.SMTP_PASS = "password";

    // Clear mocks
    vi.clearAllMocks();
    sendMailMock.mockResolvedValue({ messageId: "email_123" });

    // Dynamic import to ensure fresh module evaluation with new env vars
    emailService = await import("../services/emailService.js");
  });

  afterEach(() => {
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
  });

  it("should initialize Nodemailer with correct config", () => {
    expect(nodemailer.createTransport).toHaveBeenCalledWith({
      host: "smtp.test.com",
      port: 587,
      secure: false,
      auth: {
        user: "test@krypton.com",
        pass: "password",
      },
      family: 4,
      tls: {
        rejectUnauthorized: false,
      },
      connectionTimeout: 10000,
      greetingTimeout: 5000,
      socketTimeout: 10000,
    });
  });

  it("should send activation email successfully", async () => {
    const result = await emailService.sendActivationEmail(
      "test@example.com",
      "John",
      "http://link.com",
    );

    expect(result).toEqual({ messageId: "email_123" });
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "test@example.com",
        subject: "Activate your Krypton Drive account",
        html: expect.stringContaining("Welcome, John!"),
      }),
    );
  });

  it("should send password reset email successfully", async () => {
    const result = await emailService.sendPasswordResetEmail(
      "user@example.com",
      "http://reset.com",
    );

    expect(result).toEqual({ messageId: "email_123" });
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user@example.com",
        subject: "Reset your Krypton Drive password",
      }),
    );
  });

  it("should send password changed email successfully", async () => {
    const details = { time: "10:00 AM", ip: "127.0.0.1" };
    const result = await emailService.sendPasswordChangedEmail(
      "user@example.com",
      "John",
      details,
    );

    expect(result).toEqual({ messageId: "email_123" });
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user@example.com",
        subject: "Your Krypton Drive password was changed",
        html: expect.stringContaining("10:00 AM"),
      }),
    );
  });

  it("should handle sending errors gracefully", async () => {
    sendMailMock.mockRejectedValue(new Error("SMTP Connection Failed"));

    await expect(
      emailService.sendActivationEmail("fail@test.com", "User", "link"),
    ).rejects.toThrow(/Email Send Failed.*SMTP Connection Failed/);
  });
});
