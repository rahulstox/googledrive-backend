import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import nodemailer from "nodemailer";

// Mock ioredis
vi.mock("ioredis", () => {
  return {
    default: vi.fn(function () {
      return {
        incr: vi.fn().mockResolvedValue(1),
        expire: vi.fn().mockResolvedValue(1),
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue("OK"),
        on: vi.fn(),
      };
    }),
  };
});

// Mock prom-client
vi.mock("prom-client", () => {
  return {
    default: {
      register: {
        getSingleMetric: vi.fn(),
        registerMetric: vi.fn(),
      },
      Counter: class {
        constructor() {
          this.inc = vi.fn();
        }
      },
      Histogram: class {
        constructor() {
          this.startTimer = vi.fn(() => vi.fn());
        }
      },
    },
  };
});

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
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "smtp.test.com",
        port: 587,
        secure: false,
        auth: {
          user: "test@krypton.com",
          pass: "password",
        },
        pool: true,
        maxConnections: 5,
        maxMessages: 100,
        tls: {
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
        },
      }),
    );
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
        html: expect.stringContaining("Welcome to Krypton Drive, John!"),
      }),
    );
  });

  it.skip("should send password reset email successfully", async () => {
    /*
    const result = await emailService.sendPasswordResetEmail(
      "user@example.com",
      "http://reset.com",
    );
    */
  });

  it.skip("should send password changed email successfully", async () => {
    /*
    const details = { time: "10:00 AM", ip: "127.0.0.1" };
    const result = await emailService.sendPasswordChangedEmail(
      "user@example.com",
      "John",
      details,
    );
    */
  });

  it("should handle sending errors and retry logic", async () => {
    vi.useFakeTimers();
    const error = new Error("SMTP Connection Failed");
    // @ts-ignore
    error.responseCode = 421; // Transient
    sendMailMock.mockRejectedValue(error);

    const promise = emailService.sendActivationEmail(
      "fail@test.com",
      "User",
      "link",
    );

    // Attach the expectation handler immediately to prevent UnhandledRejection
    const checkPromise = expect(promise).rejects.toThrow(
      /Email failed after 5 attempts/,
    );

    // Fast-forward through retries
    // We need to advance time enough to cover all backoffs (2+4+8+16+32 = 62s)
    // We do this incrementally to ensure the event loop processes each retry
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(40000); // Advance more than max backoff each time
    }

    await checkPromise;
    expect(sendMailMock).toHaveBeenCalledTimes(6); // Initial + 5 retries

    vi.useRealTimers();
  });
});
