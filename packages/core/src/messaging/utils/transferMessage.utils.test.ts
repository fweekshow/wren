import { describe, expect, it } from "vitest";

import {
  extractExplicitTransferMessage,
  isTransferMessageSkip,
  normalizeTransferMessage,
  stripExplicitTransferMessage,
} from "./transferMessage.utils.js";

describe("transfer message utilities", () => {
  it("extracts explicit message and note clauses", () => {
    expect(
      extractExplicitTransferMessage(
        "Send Mateo 0.01 USDC with message Thank you for the pizza",
      ),
    ).toBe("Thank you for the pizza");
    expect(extractExplicitTransferMessage("send 1 USDC to Alex note: 'lunch'")).toBe("lunch");
    expect(
      stripExplicitTransferMessage("send 1 USDC to Alex with message Thank you"),
    ).toBe("send 1 USDC to Alex");
  });

  it("does not treat an implied purpose as an explicit message", () => {
    expect(extractExplicitTransferMessage("send 1 USDC to Alex for lunch")).toBeNull();
  });

  it("normalizes replies and recognizes skip choices", () => {
    expect(normalizeTransferMessage("  “Great dinner”  ")).toBe("Great dinner");
    expect(isTransferMessageSkip("no message")).toBe(true);
    expect(isTransferMessageSkip("Thank you")).toBe(false);
  });
});
