import { describe, it, expect } from "vitest";
import request from "supertest";
import express from "express";
import authRoutes from "../routes/authRoutes.js";
import User from "../models/User.js";

// Mock dependencies
import { vi } from "vitest";
vi.mock("../models/User.js", () => ({
  default: {
    findOne: vi.fn(),
    create: vi.fn(),
  },
}));
vi.mock("../services/emailService.js", () => ({
  sendActivationEmail: vi.fn(),
}));
vi.mock("../services/metrics.js", () => ({
  registrationTotal: { inc: vi.fn() },
  registrationDuration: { startTimer: () => vi.fn() },
  emailSendTotal: { inc: vi.fn() },
  activationTotal: { inc: vi.fn() },
}));

const app = express();
app.use(express.json());
app.use("/api/auth", authRoutes);

describe("Email Validation Logic", () => {
  const validEmails = [
    "simple@example.com",
    "very.common@example.com",
    "disposable.style.email.with+symbol@example.com",
    "other.email-with-hyphen@example.com",
    "fully-qualified-domain@example.com",
    "user.name+tag+sorting@example.com",
    "example-indeed@strange-example.com",
    "admin@mailserver1", // RFC 5322 allows local parts, but our regex enforces TLD (which is good for web)
    // Wait, our regex enforces TLD of at least 2 chars.
  ];

  const strictValidEmails = [
    "user@domain.com",
    "user.name@domain.co.uk",
    "user+tag@domain.com",
    "user123@sub.domain.org",
  ];

  const invalidEmails = [
    "plainaddress",
    "#@%^%#$@#$@#.com",
    "@example.com",
    "Joe Smith <email@example.com>",
    "email.example.com",
    "email@example@example.com",
    ".email@example.com",
    "email.@example.com",
    "email..email@example.com",
    "email@example.com (Joe Smith)",
    "email@example",
    "email@-example.com",
    "email@111.222.333.44444",
    "email@example..com",
    "Abc..123@example.com",
  ];

  // We are testing the POST /register route validation

  it("should accept valid emails", async () => {
    // Fix mock for this test
    User.create.mockResolvedValue({ _id: "newuser123" });

    for (const email of strictValidEmails) {
      const res = await request(app).post("/api/auth/register").send({
        email,
        password: "Password123!",
        firstName: "Test",
        lastName: "User",
      });
      if (res.status === 400) {
        console.log(`Failed valid email: ${email}`, res.body);
      }
      expect(res.status).not.toBe(400);
      expect(res.status).not.toBe(500); // Should succeed or be 201
    }
  });

  it("should reject invalid emails", async () => {
    // Fix mock just in case validation slips through (it shouldn't)
    User.create.mockResolvedValue({ _id: "failuser" });

    for (const email of invalidEmails) {
      const res = await request(app).post("/api/auth/register").send({
        email,
        password: "Password123!",
        firstName: "Test",
        lastName: "User",
      });
      if (res.status !== 400) {
        console.log(`Accepted invalid email: ${email}`, res.status);
      }
      expect(res.status).toBe(400);
      expect(res.body.errors[0].msg).toBe(
        "Please provide a valid email address",
      );
    }
  });
});
