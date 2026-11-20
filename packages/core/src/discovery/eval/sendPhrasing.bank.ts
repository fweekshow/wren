/**
 * Shared send-phrasing fixture bank — source of truth for teammate NL variants.
 * Unit tests consume deterministic helpers; routing eval maps positives/negatives
 * onto DiscoveryAI.respond() expectations.
 */

export type SendPhrasingExpect = {
  to?: string;
  amount?: string;
  asset?: string;
  memo?: string;
};

export type SendPhrasingCase = {
  id: string;
  input: string;
  kind: "positive" | "negative";
  /** Expected send_token args (positives). Amounts may be ".01" or "0.01". */
  expect?: SendPhrasingExpect;
  note?: string;
};

export const SEND_PHRASING_BANK: SendPhrasingCase[] = [
  // Word order
  {
    id: "send-recipient-first",
    input: "Send Degeneer .01 USDC",
    kind: "positive",
    expect: { to: "Degeneer", amount: ".01", asset: "USDC" },
  },
  {
    id: "send-amount-first-to",
    input: "Send 0.01 USDC to Degeneer",
    kind: "positive",
    expect: { to: "Degeneer", amount: "0.01", asset: "USDC" },
  },
  {
    id: "send-recipient-amount-asset",
    input: "Send Degeneer 0.01 USDC",
    kind: "positive",
    expect: { to: "Degeneer", amount: "0.01", asset: "USDC" },
  },
  {
    id: "transfer-to",
    input: "Transfer .01 USDC to Degeneer",
    kind: "positive",
    expect: { to: "Degeneer", amount: ".01", asset: "USDC" },
  },

  // Verbs
  {
    id: "pay-verb",
    input: "Pay Degeneer .01 USDC",
    kind: "positive",
    expect: { to: "Degeneer", amount: ".01", asset: "USDC" },
  },
  {
    id: "give-verb",
    input: "Give Degeneer .01 USDC",
    kind: "positive",
    expect: { to: "Degeneer", amount: ".01", asset: "USDC" },
  },
  {
    id: "tip-verb",
    input: "Tip Degeneer .01 USDC",
    kind: "positive",
    expect: { to: "Degeneer", amount: ".01", asset: "USDC" },
  },
  {
    id: "shoot-verb",
    input: "Shoot Degeneer .01 USDC",
    kind: "positive",
    expect: { to: "Degeneer", amount: ".01", asset: "USDC" },
  },
  {
    id: "toss-verb",
    input: "Toss Degeneer .01 USDC",
    kind: "positive",
    expect: { to: "Degeneer", amount: ".01", asset: "USDC" },
  },
  {
    id: "fire-over",
    input: "Fire over .01 USDC to Degeneer",
    kind: "positive",
    expect: { to: "Degeneer", amount: ".01", asset: "USDC" },
  },

  // Polite wrappers
  {
    id: "can-you-send",
    input: "Can you send .01 USDC to Degeneer?",
    kind: "positive",
    expect: { to: "Degeneer", amount: ".01", asset: "USDC" },
  },
  {
    id: "please-send",
    input: "Please send .01 USDC to Degeneer.",
    kind: "positive",
    expect: { to: "Degeneer", amount: ".01", asset: "USDC" },
  },
  {
    id: "help-me-send",
    input: "Help me send .01 USDC to Degeneer.",
    kind: "positive",
    expect: { to: "Degeneer", amount: ".01", asset: "USDC" },
  },
  {
    id: "i-want-to-send",
    input: "I want to send Degeneer .01 USDC.",
    kind: "positive",
    expect: { to: "Degeneer", amount: ".01", asset: "USDC" },
  },
  {
    id: "could-you-send",
    input: "Could you send Degeneer .01 USDC?",
    kind: "positive",
    expect: { to: "Degeneer", amount: ".01", asset: "USDC" },
  },

  // Word amounts
  {
    id: "one-cent-usdc",
    input: "Send Degeneer one cent USDC",
    kind: "positive",
    expect: { to: "Degeneer", amount: "0.01", asset: "USDC" },
  },
  {
    id: "a-penny-in-usdc",
    input: "Send a penny in USDC to Degeneer",
    kind: "positive",
    expect: { to: "Degeneer", amount: "0.01", asset: "USDC" },
  },
  {
    id: "1-cent-usdc",
    input: "Send 1 cent USDC to Degeneer",
    kind: "positive",
    expect: { to: "Degeneer", amount: "0.01", asset: "USDC" },
  },
  {
    id: "a-cent",
    input: "Send Degeneer a cent",
    kind: "positive",
    expect: { to: "Degeneer", amount: "0.01", asset: "USDC" },
    note: "Bare 'a cent' defaults to USDC",
  },
  {
    id: "penny-worth-of-usdc",
    input: "Send Degeneer one cent worth of USDC.",
    kind: "positive",
    expect: { to: "Degeneer", amount: "0.01", asset: "USDC" },
  },
  {
    id: "a-penny-in-usdc-period",
    input: "Send Degeneer a penny in USDC.",
    kind: "positive",
    expect: { to: "Degeneer", amount: "0.01", asset: "USDC" },
  },

  // Amount forms (basename path for deterministic regression)
  {
    id: "leading-decimal-basename",
    input: "send .01 usdc to degeneer03.base.eth",
    kind: "positive",
    expect: { to: "degeneer03.base.eth", amount: ".01", asset: "USDC" },
  },
  {
    id: "trailing-zero-decimal",
    input: "send .010 usdc to degeneer03.base.eth",
    kind: "positive",
    expect: { to: "degeneer03.base.eth", amount: ".010", asset: "USDC" },
  },
  {
    id: "pay-contact-numeric",
    input: "pay bob 5 usdc",
    kind: "positive",
    expect: { to: "bob", amount: "5", asset: "USDC" },
  },
  {
    id: "basename-amount",
    input: "send 6.7 usdc to bob.base.eth",
    kind: "positive",
    expect: { to: "bob.base.eth", amount: "6.7", asset: "USDC" },
  },
  {
    id: "usd-recipient-first-basename",
    input: "send jesse.base.eth $5",
    kind: "positive",
    expect: { to: "jesse.base.eth", asset: "USDC" },
  },

  // Asset synonym
  {
    id: "stables-synonym",
    input: "send Degeneer .01 stables",
    kind: "positive",
    expect: { to: "Degeneer", amount: ".01", asset: "USDC" },
    note: "stables → USDC",
  },

  // Memo
  {
    id: "memo-for-lunch",
    input: "send Degeneer .01 usdc for lunch",
    kind: "positive",
    expect: { to: "Degeneer", amount: ".01", asset: "USDC", memo: "lunch" },
  },
  {
    id: "tip-penny-memo",
    input: "Can you tip Degeneer a penny in USDC for lunch?",
    kind: "positive",
    expect: { to: "Degeneer", amount: "0.01", asset: "USDC", memo: "lunch" },
  },
  {
    id: "no-memo-bare",
    input: "send Degeneer .01 usdc",
    kind: "positive",
    expect: { to: "Degeneer", asset: "USDC" },
    note: "Must not invent a memo",
  },

  // Negatives — must NOT call send_token
  {
    id: "neg-what-is-usdc",
    input: "what is USDC?",
    kind: "negative",
    note: "Informational — no send",
  },
  {
    id: "neg-how-do-i-send",
    input: "how do I send crypto?",
    kind: "negative",
    note: "How-to question — no send",
  },
  {
    id: "neg-missing-recipient",
    input: "send .01 usdc",
    kind: "negative",
    note: "Missing recipient — ask, do not invent `to`",
  },
];

/** Cases suitable for routing-eval tool-arg assertions. */
export function sendPhrasingRoutingCases(): SendPhrasingCase[] {
  return SEND_PHRASING_BANK;
}
