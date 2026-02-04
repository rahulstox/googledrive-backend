import { describe, it, expect, vi, beforeEach } from "vitest";

// Use vi.hoisted to ensure mocks are available for the hoisted vi.mock call
const mocks = vi.hoisted(() => ({
  sendMail: vi.fn().mockResolvedValue({ messageId: "test-id" }),
  verify: vi.fn((cb) => cb && cb(null, true)),
}));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => ({
      sendMail: mocks.sendMail,
      verify: mocks.verify,
    })),
  },
}));

import {
  sendActivationEmail,
  sendPasswordResetEmail,
} from "../services/emailService.js";

describe("Email Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendMail.mockResolvedValue({ messageId: "test-id" });
  });

  it("should send activation email with correct link and subject", async () => {
    const email = "test@example.com";
    const firstName = "TestUser";
    const link = "https://krypton.com/activate?token=abc";

    await sendActivationEmail(email, firstName, link);

    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    const callArgs = mocks.sendMail.mock.calls[0][0];
    expect(callArgs.to).toBe(email);
    expect(callArgs.subject).toContain("Activate");
    expect(callArgs.html).toContain(link);
    expect(callArgs.html).toContain(firstName);
  });

  it("should send password reset email with correct link", async () => {
    const email = "reset@example.com";
    const firstName = "ResetUser";
    const link = "https://krypton.com/reset?token=xyz";

    await sendPasswordResetEmail(email, firstName, link);

    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
    const callArgs = mocks.sendMail.mock.calls[0][0];
    expect(callArgs.to).toBe(email);
    expect(callArgs.subject).toContain("Reset");
    expect(callArgs.html).toContain(link);
  });

  it("should throw error if transport fails", async () => {
    const error = new Error("SMTP connection timeout");
    mocks.sendMail.mockRejectedValue(error);

    await expect(
      sendActivationEmail("fail@test.com", "Fail", "link"),
    ).rejects.toThrow("SMTP connection timeout");
  });
});
