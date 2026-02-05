import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import nodemailer from "nodemailer";
import { Resend } from "resend";

// --- 1. HOIST MOCKS (Define them before anything else to prevent ReferenceError) ---
const { sendMailMock, sendResendMock } = vi.hoisted(() => {
  return {
    sendMailMock: vi.fn(),
    sendResendMock: vi.fn(),
  };
});

// --- 2. SETUP MOCKS ---

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

// Mock Resend (Using the hoisted variable)
vi.mock("resend", () => {
  return {
    Resend: class {
      constructor() {
        this.emails = { send: sendResendMock };
      }
    },
  };
});

// Mock Nodemailer (Using the hoisted variable)
vi.mock("nodemailer", () => {
  return {
    default: {
      createTransport: vi.fn(() => ({
        sendMail: sendMailMock,
      })),
    },
  };
});

// --- 3. TESTS ---
describe("Email Service", () => {
  let emailService;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    // Default: SMTP Fallback Setup (No Resend Key)
    process.env.SMTP_HOST = "smtp.test.com";
    process.env.SMTP_USER = "test@krypton.com";
    process.env.SMTP_PASS = "password";
    delete process.env.RESEND_API_KEY;

    // Reset default mock implementations
    sendMailMock.mockResolvedValue({ messageId: "email_123" });
    sendResendMock.mockResolvedValue({
      data: { id: "resend_123" },
      error: null,
    });

    // Dynamic import to pick up new env vars
    emailService = await import("../services/emailService.js");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.RESEND_API_KEY;
  });

  // Test 1: SMTP Fallback (When Resend Key is missing)
  it("should fall back to Nodemailer when RESEND_API_KEY is missing", async () => {
    const result = await emailService.sendActivationEmail(
      "user@smtp.com",
      "John",
      "link",
    );

    // Should verify SMTP was used
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 465,
        secure: true,
        auth: { user: "test@krypton.com", pass: "password" },
      }),
    );
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sendResendMock).not.toHaveBeenCalled();
    expect(result).toHaveProperty("messageId", "email_123");
  });

  // Test 2: Resend Priority (When Key is present)
  it("should prioritize Resend API when RESEND_API_KEY is set", async () => {
    vi.resetModules(); // Reset to reload env vars
    process.env.RESEND_API_KEY = "re_123_test";

    // Re-import service with new Env
    const emailServiceWithResend = await import("../services/emailService.js");

    const result = await emailServiceWithResend.sendActivationEmail(
      "user@resend.com",
      "Jane",
      "link",
    );

    expect(sendResendMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock).not.toHaveBeenCalled(); // Ensure SMTP was skipped
    expect(result.data).toHaveProperty("id", "resend_123");
  });
});
