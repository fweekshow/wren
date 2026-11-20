import { describe, expect, it } from "vitest";

/**
 * Guard: user-facing phone-send templates must never contain the word "escrow".
 * Internal identifiers (PhoneEscrowAdapter, pendingEscrowConfirm) are fine —
 * this list is the copy users actually read.
 */
const USER_FACING_PHONE_SEND_TEMPLATES = [
  "that send expired — just ask again and i'll set it up.",
  "reply YES to send 1 USDC for Alice (+15551234567) to claim, or NO to cancel.",
  "how much USDC should i send for Alice to claim? try \"send 10 USDC to Alice\".",
  "sending to a phone works with tokens like USDC, not ETH.",
  "i can still send USDC for them to claim in the meantime",
  "i'll send 1 USDC so Alice can claim it at +15551234567",
  "Send 1 USDC for manila to claim",
  "Approve 1 USDC so they can claim",
  "Send 1 USDC for them to claim",
  "1 USDC is now in your Basemate wallet — ready to use",
  "Basemate wallet connected, but i couldn't finish releasing your claim yet — i'll try again later.",
  "sending to a phone isn't set up yet — try sending to a Basemate wallet address instead.",
  "couldn't create that claim link — try again in a moment.",
  "Secure setup",
  "You'll never need to pay or share a password to receive this transfer.",
];

describe("phone-send claim copy", () => {
  it("does not use the word escrow in user-facing templates", () => {
    for (const line of USER_FACING_PHONE_SEND_TEMPLATES) {
      expect(line).not.toMatch(/\bescrow\b/i);
    }
  });
});
