import { describe, expect, it, vi } from "vitest";

import {
  applySmsConsent,
  classifySmsKeyword,
  decideSmsConsent,
  decideRecipientTransfer,
  decideSpectrumOutbound,
  isSpectrumSmsDm,
  SMS_ENROLLED,
  SMS_HELP,
  SMS_OPT_IN_ASK,
  SMS_STOP,
  SMS_WELCOME,
  type SmsConsentStamp,
  type SmsConsentStatus,
  type SmsConsentStore,
} from "./smsConsent.js";

function memoryStore(initial: SmsConsentStatus | null = null) {
  let status = initial;
  const save = vi.fn(async (phone: string, next: SmsConsentStatus, _stamp: SmsConsentStamp) => {
    expect(phone).toBe("+15551234567");
    status = next;
  });
  const deps: SmsConsentStore = {
    normalize: (raw) => (raw.startsWith("+") ? raw : null),
    getStatus: async () => status,
    save,
  };
  return { deps, save, read: () => status };
}

describe("isSpectrumSmsDm", () => {
  it("treats a non-iMessage DM as SMS and leaves iMessage and groups alone", () => {
    expect(isSpectrumSmsDm(false, "SMS")).toBe(true);
    expect(isSpectrumSmsDm(false, "RCS")).toBe(true);
    expect(isSpectrumSmsDm(false, "iMessage")).toBe(false);
    expect(isSpectrumSmsDm(true, "SMS")).toBe(false);
    expect(isSpectrumSmsDm(true, "iMessage")).toBe(false);
  });
});

describe("classifySmsKeyword", () => {
  it("matches CONFIRM, Y, YES, STOP, and HELP after trim, ignoring case", () => {
    expect(classifySmsKeyword(" confirm ")).toBe("confirm");
    expect(classifySmsKeyword("Confirm")).toBe("confirm");
    expect(classifySmsKeyword(" y ")).toBe("yes");
    expect(classifySmsKeyword("Yes")).toBe("yes");
    expect(classifySmsKeyword("stop")).toBe("stop");
    expect(classifySmsKeyword("Help")).toBe("help");
    expect(classifySmsKeyword("YES PLEASE")).toBe("other");
    expect(classifySmsKeyword("CONFIRM PLEASE")).toBe("other");
    expect(classifySmsKeyword("STOPALL")).toBe("other");
  });
});

describe("decideSmsConsent", () => {
  it("starts the welcome only when a new number texts CONFIRM", () => {
    expect(decideSmsConsent(null, "confirm")).toEqual({
      action: "reply",
      reply: SMS_WELCOME,
      status: "pending",
      stamp: null,
    });
    expect(decideSmsConsent(null, "  Confirm  ")).toMatchObject({
      reply: SMS_WELCOME,
      status: "pending",
    });
    expect(decideSmsConsent(null, "hi")).toEqual({ action: "silence" });
    expect(decideSmsConsent(null, "Y")).toEqual({ action: "silence" });
    expect(SMS_WELCOME).toBe(
      "Basemate, a service of Stablemate Labs Inc: texts when a payment or stock is sent to you. Message frequency varies. Message and data rates may apply. Reply HELP for help, STOP to opt out. Terms: https://basemate.app/terms Privacy: https://basemate.app/privacy. Reply Y to confirm.",
    );
  });

  it("enrolls only a pending Y or YES and stays quiet otherwise", () => {
    expect(decideSmsConsent("pending", "YES")).toEqual({
      action: "reply",
      reply: SMS_ENROLLED,
      status: "opted_in",
      stamp: "opted_in",
    });
    expect(decideSmsConsent("pending", "y")).toMatchObject({
      reply: SMS_ENROLLED,
      status: "opted_in",
    });
    expect(decideSmsConsent("pending", "later")).toEqual({ action: "silence" });
    expect(decideSmsConsent("pending", "CONFIRM")).toEqual({ action: "silence" });
  });

  it("is silent after opt-in except for STOP and HELP", () => {
    expect(decideSmsConsent("opted_in", "what's my balance")).toEqual({ action: "silence" });
    expect(decideSmsConsent("opted_in", "HELP")).toMatchObject({
      reply: SMS_HELP,
      status: null,
    });
    expect(decideSmsConsent("opted_in", "STOP")).toEqual({
      action: "reply",
      reply: SMS_STOP,
      status: "opted_out",
      stamp: "opted_out",
    });
  });

  it("sends HELP without changing status and STOP from any state", () => {
    expect(decideSmsConsent(null, "HELP")).toEqual({
      action: "reply",
      reply: SMS_HELP,
      status: null,
      stamp: null,
    });
    expect(decideSmsConsent("pending", "stop")).toMatchObject({
      reply: SMS_STOP,
      status: "opted_out",
      stamp: "opted_out",
    });
    expect(decideSmsConsent("opted_out", "STOP")).toMatchObject({ status: "opted_out" });
  });

  it("restarts the welcome after opt-out only when they text CONFIRM", () => {
    expect(decideSmsConsent("opted_out", "CONFIRM")).toMatchObject({
      reply: SMS_WELCOME,
      status: "pending",
    });
    expect(decideSmsConsent("opted_out", "hello")).toEqual({ action: "silence" });
    expect(decideSmsConsent("opted_out", "Y")).toEqual({ action: "silence" });
    expect(decideSmsConsent("opted_out", "HELP")).toMatchObject({
      reply: SMS_HELP,
      status: null,
    });
  });
});

describe("applySmsConsent", () => {
  it("persists pending only for CONFIRM, then opted_in only for Y", async () => {
    const store = memoryStore(null);
    await expect(applySmsConsent("+15551234567", "send me money", store.deps)).resolves.toEqual({
      reply: null,
    });
    expect(store.save).not.toHaveBeenCalled();
    expect(store.read()).toBeNull();

    await expect(applySmsConsent("+15551234567", "CONFIRM", store.deps)).resolves.toEqual({
      reply: SMS_WELCOME,
    });
    expect(store.save).toHaveBeenCalledWith("+15551234567", "pending", null);
    expect(store.read()).toBe("pending");

    store.save.mockClear();
    await expect(applySmsConsent("+15551234567", "hello", store.deps)).resolves.toEqual({
      reply: null,
    });
    expect(store.save).not.toHaveBeenCalled();
    expect(store.read()).toBe("pending");

    await expect(applySmsConsent("+15551234567", "Y", store.deps)).resolves.toEqual({
      reply: SMS_ENROLLED,
    });
    expect(store.save).toHaveBeenCalledWith("+15551234567", "opted_in", "opted_in");
  });

  it("does not write or reply when an opted-in user texts anything else", async () => {
    const store = memoryStore("opted_in");
    await expect(applySmsConsent("+15551234567", "buy ETH", store.deps)).resolves.toEqual({
      reply: null,
    });
    expect(store.save).not.toHaveBeenCalled();
    expect(store.read()).toBe("opted_in");
  });

  it("does not change status on HELP and records STOP", async () => {
    const store = memoryStore("pending");
    await expect(applySmsConsent("+15551234567", "help", store.deps)).resolves.toEqual({
      reply: SMS_HELP,
    });
    expect(store.save).not.toHaveBeenCalled();

    await expect(applySmsConsent("+15551234567", "STOP", store.deps)).resolves.toEqual({
      reply: SMS_STOP,
    });
    expect(store.save).toHaveBeenCalledWith("+15551234567", "opted_out", "opted_out");
  });

  it("stays silent when the handle cannot be normalized", async () => {
    const store = memoryStore(null);
    await expect(applySmsConsent("not-a-phone", "hi", store.deps)).resolves.toEqual({
      reply: null,
    });
    expect(store.save).not.toHaveBeenCalled();
  });
});

describe("SMS_OPT_IN_ASK", () => {
  it("tells the sender to have the contact text CONFIRM and reply Y", () => {
    expect(SMS_OPT_IN_ASK).toBe(
      "They won't get a text until they text CONFIRM to +1 (628) 316-5638 and reply Y.",
    );
  });
});

describe("decideRecipientTransfer", () => {
  it("holds the payment text until the recipient has replied Y", () => {
    expect(decideRecipientTransfer(null)).toBe("hold");
    expect(decideRecipientTransfer("pending")).toBe("hold");
    expect(decideRecipientTransfer("opted_out")).toBe("hold");
    expect(decideRecipientTransfer("opted_in")).toBe("send");
  });
});

describe("decideSpectrumOutbound", () => {
  it("sends payment confirmations only after opt-in once a consent row exists", () => {
    expect(decideSpectrumOutbound(null, "payment_or_stock")).toBe("send");
    expect(decideSpectrumOutbound("pending", "payment_or_stock")).toBe("suppress");
    expect(decideSpectrumOutbound("opted_out", "payment_or_stock")).toBe("suppress");
    expect(decideSpectrumOutbound("opted_in", "payment_or_stock")).toBe("send");
  });

  it("drops every other proactive send for an SMS-program phone", () => {
    expect(decideSpectrumOutbound(null, "other")).toBe("send");
    expect(decideSpectrumOutbound("opted_in", "other")).toBe("suppress");
    expect(decideSpectrumOutbound("pending", "other")).toBe("suppress");
  });
});
