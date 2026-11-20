import { describe, expect, it, vi } from "vitest";

vi.mock("@/discovery/adapters/priceAlert.adapter.js", () => {
  const inserted: any[] = [];
  return {
    PriceAlertAdapter: {
      __inserted: inserted,
      async insert(input: any) {
        const row = { id: inserted.length + 1, ...input };
        inserted.push(row);
        return row;
      },
    },
  };
});

import { PriceAlertAdapter } from "@/discovery/adapters/priceAlert.adapter.js";

import { parseAlertIntent } from "./parser.js";
import { pendingAlerts, pendingAlertKey } from "./pending.js";
import { createAlertFromIntent } from "./service.js";

type Route = [string, unknown];

function makeFetch(routes: Route[]): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    for (const [frag, data] of routes) {
      if (u.includes(frag)) {
        return { ok: true, json: async () => data } as Response;
      }
    }
    return { ok: false, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;
}

const inserted = (PriceAlertAdapter as unknown as { __inserted: any[] }).__inserted;

const ADDRESS = "0x07E61D8a4e197dfC269e90D7ECe1dF0D26702bA3";

describe("ambiguous → contract-address follow-up", () => {
  it("stores the pending intent on ambiguity, then completes via address", async () => {
    inserted.length = 0;

    const ambiguousFetch = makeFetch([
      [
        "dex/search",
        {
          pairs: [
            {
              chainId: "base",
              baseToken: { address: "0xaaa", symbol: "BASEMATE", name: "One" },
              liquidity: { usd: 50000 },
              priceUsd: "0.5",
            },
            {
              chainId: "base",
              baseToken: { address: "0xbbb", symbol: "BASEMATE", name: "Two" },
              liquidity: { usd: 9000 },
              priceUsd: "0.4",
            },
          ],
        },
      ],
    ]);

    const core = {
      platform: "xmtp" as const,
      userKey: "inbox-1",
      dmTarget: { walletAddress: "0xabc" },
      sourceConversationId: "dm-1",
      sourceIsGroup: false,
    };
    const key = pendingAlertKey(core.platform, core.userKey, core.sourceConversationId);

    const intent = parseAlertIntent("alert me when $BASEMATE hits 0.000004");
    expect(intent).not.toBeNull();
    if (!intent) return;

    const first = await createAlertFromIntent(
      { ...core, resolveOptions: { fetchFn: ambiguousFetch } },
      intent,
    );
    expect(first.kind).toBe("ambiguous");
    expect(inserted).toHaveLength(0);

    // Simulate the platform remembering the pending request.
    pendingAlerts.set(key, intent);
    const remembered = pendingAlerts.get(key);
    expect(remembered).not.toBeNull();
    if (!remembered) return;

    const addressFetch = makeFetch([
      [
        "dex/tokens/",
        {
          pairs: [
            {
              chainId: "base",
              baseToken: { address: ADDRESS, symbol: "BASEMATE", name: "Basemate" },
              liquidity: { usd: 120000 },
              priceUsd: "0.0000031",
            },
          ],
        },
      ],
    ]);

    const second = await createAlertFromIntent(
      { ...core, resolveOptions: { fetchFn: addressFetch } },
      { ...remembered, contractAddress: ADDRESS, tokenQuery: ADDRESS },
    );

    expect(second.kind).toBe("created");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      platform: "xmtp",
      symbol: "BASEMATE",
      tokenAddress: ADDRESS,
      metric: "price_usd",
      targetValue: 0.000004,
    });

    pendingAlerts.delete(key);
    expect(pendingAlerts.get(key)).toBeNull();
  });

  it("extracts a contract address from a noisy follow-up message", async () => {
    const { extractContractAddress } = await import("./parser.js");
    expect(extractContractAddress(`${ADDRESS} this one`)).toBe(ADDRESS);
    expect(extractContractAddress("no address here")).toBeNull();
  });
});
