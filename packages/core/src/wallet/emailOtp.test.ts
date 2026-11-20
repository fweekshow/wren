import { beforeEach, describe, expect, it, vi } from "vitest";

const emailOtpTestState = vi.hoisted(() => {
  type Row = {
    userPhone: string;
    email: string | null;
    tosAcceptedAt: Date | null;
    phoneVerifiedAt: Date | null;
    emailVerifiedAt: Date | null;
    pendingPhoneOtp: string | null;
    pendingPhoneOtpExpiresAt: Date | null;
    pendingEmailOtp: string | null;
    pendingEmailOtpExpiresAt: Date | null;
  };
  const rows = new Map<string, Row>();
  const sendMail = vi.fn(async () => undefined);
  const createTransport = vi.fn(() => ({ sendMail }));
  const baseRow = (userPhone: string): Row => ({
    userPhone,
    email: null,
    tosAcceptedAt: null,
    phoneVerifiedAt: null,
    emailVerifiedAt: null,
    pendingPhoneOtp: null,
    pendingPhoneOtpExpiresAt: null,
    pendingEmailOtp: null,
    pendingEmailOtpExpiresAt: null,
  });
  const upsert = async (userPhone: string, updates: Partial<Omit<Row, "userPhone">>) => {
    rows.set(userPhone, { ...(rows.get(userPhone) ?? baseRow(userPhone)), ...updates });
  };
  return { rows, sendMail, createTransport, upsert };
});

vi.mock("@/config/config.js", () => ({
  config: {
    env: "production",
    cdp: { onrampSandbox: false },
    email: {
      enabled: true,
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      smtpSecure: false,
      smtpUser: "user",
      smtpPass: "pass",
      from: "Basemate <noreply@example.com>",
    },
  },
}));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: emailOtpTestState.createTransport,
  },
}));

vi.mock("./onrampUserData.js", () => ({
  OnrampUserDataAdapter: {
    async get(userPhone: string) {
      return emailOtpTestState.rows.get(userPhone) ?? null;
    },
    upsert: emailOtpTestState.upsert,
  },
}));

import {
  issueEmailOtp,
  resendEmailOtp,
  sendEmailOtp,
  verifyEmailOtp,
} from "./emailOtp.js";

describe("emailOtp", () => {
  beforeEach(() => {
    emailOtpTestState.rows.clear();
    emailOtpTestState.sendMail.mockClear();
    emailOtpTestState.createTransport.mockClear();
  });

  it("sends OTP email through nodemailer in production", async () => {
    await sendEmailOtp("alice@example.com", "123456");

    expect(emailOtpTestState.createTransport).toHaveBeenCalledWith({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      auth: { user: "user", pass: "pass" },
    });
    expect(emailOtpTestState.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "Basemate <noreply@example.com>",
        to: "alice@example.com",
        subject: "Your Basemate verification code",
        text: expect.stringContaining("123456"),
      }),
    );
  });

  it("issues and verifies a DB-backed email OTP", async () => {
    await issueEmailOtp("+15551234567", "alice@example.com");
    const issued = emailOtpTestState.rows.get("+15551234567");

    expect(issued?.email).toBe("alice@example.com");
    expect(issued?.tosAcceptedAt).toBeInstanceOf(Date);
    expect(issued?.pendingEmailOtp).toMatch(/^\d{6}$/);

    const result = await verifyEmailOtp("+15551234567", issued!.pendingEmailOtp!);

    expect(result).toEqual({ ok: true, email: "alice@example.com" });
    expect(emailOtpTestState.rows.get("+15551234567")?.emailVerifiedAt).toBeInstanceOf(Date);
    expect(emailOtpTestState.rows.get("+15551234567")?.pendingEmailOtp).toBeNull();
  });

  it("resends a fresh OTP for an unverified stored email", async () => {
    await emailOtpTestState.upsert("+15551234567", {
      email: "alice@example.com",
      pendingEmailOtp: "111111",
      pendingEmailOtpExpiresAt: new Date(Date.now() + 60_000),
    });

    const result = await resendEmailOtp("+15551234567");

    expect(result).toEqual({ ok: true, email: "alice@example.com" });
    expect(emailOtpTestState.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "alice@example.com" }),
    );
    expect(emailOtpTestState.rows.get("+15551234567")?.pendingEmailOtp).toMatch(/^\d{6}$/);
  });
});
