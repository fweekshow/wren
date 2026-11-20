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

import { setupAlertFromText } from "./service.js";

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

const ethFetch = makeFetch([
  ["simple/price", { ethereum: { usd: 1842.5, usd_market_cap: 2.2e11 } }],
]);

const inserted = (PriceAlertAdapter as unknown as { __inserted: any[] }).__inserted;

describe("setupAlertFromText", () => {
  it("creates a one-time alert and confirms with DM language", async () => {
    inserted.length = 0;
    const res = await setupAlertFromText({
      platform: "xmtp",
      userKey: "inbox-1",
      dmTarget: { walletAddress: "0xabc" },
      sourceConversationId: "dm-1",
      sourceIsGroup: false,
      text: "alert me when ETH hits $4000",
      resolveOptions: { fetchFn: ethFetch },
    });

    expect(res.kind).toBe("created");
    if (res.kind !== "created") return;
    expect(res.reply).toContain("DM you");
    expect(inserted).toHaveLength(1);
    // 1842 < 4000 → infer "above".
    expect(inserted[0]).toMatchObject({
      platform: "xmtp",
      direction: "above",
      metric: "price_usd",
      targetValue: 4000,
      symbol: "ETH",
    });
  });

  it("makes the DM-only boundary explicit for group setups", async () => {
    inserted.length = 0;
    const res = await setupAlertFromText({
      platform: "xmtp",
      userKey: "inbox-1",
      dmTarget: { walletAddress: "0xabc" },
      sourceConversationId: "group-1",
      sourceIsGroup: true,
      text: "alert me when ETH hits $4000",
      resolveOptions: { fetchFn: ethFetch },
    });
    expect(res.kind).toBe("created");
    if (res.kind !== "created") return;
    expect(res.reply.toLowerCase()).toContain("not this group");
  });

  it("asks for a contract address when the symbol is ambiguous", async () => {
    inserted.length = 0;
    const fetchFn = makeFetch([
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
    const res = await setupAlertFromText({
      platform: "xmtp",
      userKey: "inbox-1",
      dmTarget: { walletAddress: "0xabc" },
      sourceConversationId: "group-1",
      sourceIsGroup: true,
      text: "alert me when $BASEMATE hits 1M MC",
      resolveOptions: { fetchFn },
    });
    expect(res.kind).toBe("ambiguous");
    if (res.kind !== "ambiguous") return;
    expect(res.reply).toContain("contract address");
    expect(inserted).toHaveLength(0);
  });

  it("requires a DM target before creating an alert", async () => {
    inserted.length = 0;
    const res = await setupAlertFromText({
      platform: "telegram",
      userKey: "123",
      dmTarget: null,
      sourceConversationId: "group-1",
      sourceIsGroup: true,
      text: "alert me when ETH hits $4000",
      resolveOptions: { fetchFn: ethFetch },
    });
    expect(res.kind).toBe("needs_dm_target");
    expect(inserted).toHaveLength(0);
  });

  it("ignores non-alert messages", async () => {
    const res = await setupAlertFromText({
      platform: "imessage",
      userKey: "sender-1",
      dmTarget: { spaceId: "space-1" },
      sourceConversationId: "space-1",
      sourceIsGroup: false,
      text: "gm how's it going",
      resolveOptions: { fetchFn: ethFetch },
    });
    expect(res.kind).toBe("not_an_alert");
  });
});
