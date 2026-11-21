import { describe, expect, it } from "vitest";
import { amountText, cardLine, cardState, cardTitle, isClaimCode, newClaimCode, stockCardColors } from "./wrenClaim.js";
import { claimPageHtml } from "./wrenClaimPage.js";

describe("claim codes", () => {
  it("are 10 unguessable URL-safe characters", () => {
    const a = newClaimCode();
    expect(a).toMatch(/^[A-Za-z0-9]{10}$/);
    expect(newClaimCode()).not.toBe(a);
    expect(isClaimCode(a)).toBe(true);
    expect(isClaimCode("../etc")).toBe(false);
  });
});

describe("the card", () => {
  it("names the sender when known", () => {
    expect(cardTitle({ from: "Mateo", amount: "$50", stockName: "Apple" })).toBe("Mateo sent you $50 of Apple");
    expect(cardTitle({ from: null, amount: "$50", stockName: "Apple" })).toBe("You've been sent $50 of Apple");
  });
  it("formats amounts", () => {
    expect(amountText({ usd: "50" } as never)).toBe("$50");
    expect(amountText({ usd: "12.5" } as never)).toBe("$12.50");
    expect(amountText({ qty: "2" } as never)).toBe("2 shares");
  });
  it("follows the escrow", () => {
    expect(cardState({ giftTxHash: null }, null)).toBe("sending");
    expect(cardState({ giftTxHash: "0x1" }, "deposited")).toBe("waiting");
    expect(cardState({ giftTxHash: "0x1" }, "released")).toBe("claimed");
    expect(cardState({ giftTxHash: "0x1" }, "refunded")).toBe("returned");
    expect(cardLine({ state: "waiting", from: "Mateo", holdHours: 72 })).toBe("Claim it on Wren within 3 days.");
  });
  it("uses the app's stock colors", () => {
    expect(stockCardColors("AAPLc").bg).toBe("#0050FA");
  });
});

describe("the page", () => {
  const card = {
    giftId: "g1", from: "Mateo", amount: "$50", stockName: "Apple", ticker: "AAPL",
    colors: stockCardColors("AAPLc"), state: "waiting" as const, holdHours: 72,
  };
  const html = claimPageHtml({ card, pageUrl: "https://w/c/abc", imageUrl: "https://w/c/abc/card.png", appUrl: "wren://g/g1", downloadUrl: "https://testflight.apple.com/join/x" });
  it("has the tags iMessage and WhatsApp unfurl", () => {
    expect(html).toContain('property="og:title" content="Mateo sent you $50 of Apple"');
    expect(html).toContain('property="og:image" content="https://w/c/abc/card.png"');
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
  });
  it("opens the app and offers the download", () => {
    expect(html).toContain('href="wren://g/g1"');
    expect(html).toContain("testflight.apple.com");
  });
  it("escapes names", () => {
    const evil = claimPageHtml({ card: { ...card, from: '<script>"x' }, pageUrl: "p", imageUrl: "i", appUrl: "a", downloadUrl: null });
    expect(evil).not.toContain("<script>\"x");
  });
  it("offers nothing once claimed", () => {
    const done = claimPageHtml({ card: { ...card, state: "claimed" }, pageUrl: "p", imageUrl: "i", appUrl: "wren://g/g1", downloadUrl: null });
    expect(done).not.toContain("Open in Wren");
  });
});
