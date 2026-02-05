import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- MOCKS ---

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

// Mock global fetch
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

// --- TESTS ---
describe("Email Service (Brevo API)", () => {
  let emailService;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    // Set Env Vars
    process.env.BREVO_API_KEY = "xkeysib-test-key";
    process.env.EMAIL_FROM_NAME = "Krypton Test";

    // Dynamic import to pick up new env vars and mock state
    emailService = await import("../services/emailService.js");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.BREVO_API_KEY;
    delete process.env.EMAIL_FROM_NAME;
  });

  it("should send activation email successfully via Brevo", async () => {
    // Mock successful fetch response
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ messageId: "<test-msg-id@brevo>" }),
    });

    const result = await emailService.sendActivationEmail(
      "user@test.com",
      "John",
      "http://activate.link",
    );

    // Verify fetch call
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.brevo.com/v3/smtp/email",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "api-key": "xkeysib-test-key",
          "content-type": "application/json",
        }),
        body: expect.stringContaining("user@test.com"),
      }),
    );

    // Verify body content
    const callArgs = fetchMock.mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    expect(body.sender.name).toBe("Krypton Test");
    expect(body.to[0].email).toBe("user@test.com");
    expect(body.htmlContent).toContain("http://activate.link");

    // Verify result
    expect(result).toEqual({ messageId: "<test-msg-id@brevo>" });
  });

  it("should throw error when Brevo API fails", async () => {
    // Mock failed fetch response
    fetchMock.mockResolvedValue({
      ok: false,
      statusText: "Unauthorized",
      json: async () => ({ message: "Invalid API Key" }),
    });

    await expect(
      emailService.sendActivationEmail("user@test.com", "John", "http://link"),
    ).rejects.toThrow("Invalid API Key");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("should log manual fallback link on failure", async () => {
    // Mock network error
    fetchMock.mockRejectedValue(new Error("Network Error"));

    const consoleSpy = vi.spyOn(console, "log");
    const consoleErrorSpy = vi.spyOn(console, "error");

    await expect(
      emailService.sendActivationEmail(
        "user@test.com",
        "John",
        "http://manual.link",
      ),
    ).rejects.toThrow("Network Error");

    // Check if fallback link was logged
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "MANUAL FALLBACK LINK: Welcome John! Link: http://manual.link",
      ),
    );
  });
});
