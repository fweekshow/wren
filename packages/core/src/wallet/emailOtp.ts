import { randomInt } from "node:crypto";

import nodemailer, { type Transporter } from "nodemailer";

import { config } from "@/config/config.js";

import { OnrampUserDataAdapter } from "./onrampUserData.js";

export const EMAIL_OTP_TTL_MS = 10 * 60 * 1000;

export type EmailOtpVerifyResult =
  | { ok: true; email: string }
  | { ok: false; reason: "missing" | "expired" | "mismatch" };

export type EmailOtpResendResult =
  | { ok: true; email: string }
  | { ok: false; reason: "missing_email" | "already_verified" };

let transporter: Transporter | null = null;

export function generateOtp(): string {
  return String(randomInt(100000, 1000000));
}

function getTransporter(): Transporter {
  transporter ??= nodemailer.createTransport({
    host: config.email.smtpHost,
    port: config.email.smtpPort,
    secure: config.email.smtpSecure,
    auth: {
      user: config.email.smtpUser,
      pass: config.email.smtpPass,
    },
  });
  return transporter;
}

export async function sendEmailOtp(email: string, code: string): Promise<void> {
  if (config.cdp.onrampSandbox || config.env !== "production") {
    console.log(`[onramp OTP] SANDBOX email to ${email}: code ${code}`);
    return;
  }

  if (!config.email.enabled) {
    throw new Error("SMTP email config is required to send onramp OTPs in production");
  }

  await getTransporter().sendMail({
    from: config.email.from,
    to: email,
    subject: "Your Basemate verification code",
    text: [
      `Your Basemate verification code is: ${code}`,
      "",
      "This code expires in 10 minutes. If you didn't request this, you can ignore this email.",
    ].join("\n"),
  });
}

export async function issueEmailOtp(userPhone: string, email: string): Promise<void> {
  const code = generateOtp();
  await OnrampUserDataAdapter.upsert(userPhone, {
    email,
    tosAcceptedAt: new Date(),
    pendingEmailOtp: code,
    pendingEmailOtpExpiresAt: new Date(Date.now() + EMAIL_OTP_TTL_MS),
  });
  await sendEmailOtp(email, code);
}

export async function verifyEmailOtp(userPhone: string, code: string): Promise<EmailOtpVerifyResult> {
  const data = await OnrampUserDataAdapter.get(userPhone);
  if (!data?.email || !data.pendingEmailOtp || !data.pendingEmailOtpExpiresAt) {
    return { ok: false, reason: "missing" };
  }

  if (data.pendingEmailOtpExpiresAt.getTime() <= Date.now()) {
    await OnrampUserDataAdapter.upsert(userPhone, {
      pendingEmailOtp: null,
      pendingEmailOtpExpiresAt: null,
    });
    return { ok: false, reason: "expired" };
  }

  if (code !== data.pendingEmailOtp) {
    return { ok: false, reason: "mismatch" };
  }

  await OnrampUserDataAdapter.upsert(userPhone, {
    emailVerifiedAt: new Date(),
    pendingEmailOtp: null,
    pendingEmailOtpExpiresAt: null,
  });
  return { ok: true, email: data.email };
}

export async function resendEmailOtp(userPhone: string): Promise<EmailOtpResendResult> {
  const data = await OnrampUserDataAdapter.get(userPhone);
  if (!data?.email) return { ok: false, reason: "missing_email" };
  if (data.emailVerifiedAt) return { ok: false, reason: "already_verified" };

  await issueEmailOtp(userPhone, data.email);
  return { ok: true, email: data.email };
}
