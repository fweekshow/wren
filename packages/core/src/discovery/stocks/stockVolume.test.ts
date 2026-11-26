import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { listSpotBuyableOffers } from "@/discovery/doppler/stockCatalog.js";
import { resetStockVolumeCache, sortByVolume, stockVolumes24h } from "@/discovery/stocks/stockVolume.js";

describe("sortByVolume", () => {
  const items = [{ symbol: "A" }, { symbol: "B" }, { symbol: "C" }, { symbol: "D" }];

  it("puts the highest volume first and unknowns last in their original order", () => {
    const v = new Map([
      ["C", 500],
      ["A", 10],
    ]);
    expect(sortByVolume(items, v).map((i) => i.symbol)).toEqual(["C", "A", "B", "D"]);
  });

  it("keeps the original order when no volumes are known", () => {
    expect(sortByVolume(items, null)).toEqual(items);
  });
});

describe("stockVolumes24h", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetStockVolumeCache();
  });

  it("sums 24h volume across each token's pairs", async () => {
    const offers = listSpotBuyableOffers();
    const nvda = offers.find((o) => o.symbol === "NVDAc")!;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const hit = url.toLowerCase().endsWith(nvda.address.toLowerCase());
        const body = hit ? [{ volume: { h24: 100 } }, { volume: { h24: 50 } }] : [{ volume: { h24: 1 } }];
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    const v = await stockVolumes24h();
    expect(v?.get("NVDAc")).toBe(150);
    expect(v?.size).toBe(offers.length);
  });

  it("returns null when DexScreener is down and nothing is cached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    expect(await stockVolumes24h()).toBeNull();
  });
});
