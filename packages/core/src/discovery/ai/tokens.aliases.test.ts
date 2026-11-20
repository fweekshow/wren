import { describe, expect, it } from "vitest";

import { TOKEN_SYMBOL_ALIASES, resolveToken } from "./tokens.js";

describe("TOKEN_SYMBOL_ALIASES stables synonyms", () => {
  it("maps stables/dollars/bucks to USDC", () => {
    expect(TOKEN_SYMBOL_ALIASES.STABLES).toBe("USDC");
    expect(TOKEN_SYMBOL_ALIASES.STABLE).toBe("USDC");
    expect(TOKEN_SYMBOL_ALIASES.DOLLARS).toBe("USDC");
    expect(TOKEN_SYMBOL_ALIASES.BUCKS).toBe("USDC");
  });

  it("resolveToken resolves stables to USDC registry entry", () => {
    const token = resolveToken("stables");
    expect(token.symbol).toBe("USDC");
    expect(token.address.toLowerCase()).toBe("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
  });
});
