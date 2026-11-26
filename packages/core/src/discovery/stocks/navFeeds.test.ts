import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { listSpotBuyableOffers, STOCK_CATALOG } from "@/discovery/doppler/stockCatalog.js";
import { catalogNavFeeds, navFeedFor, navFeeds, parseNavFeeds, resetNavFeedsCache, withNavFeed } from "./navFeeds.js";

const offer = (symbol: string) => STOCK_CATALOG.find((o) => o.symbol === symbol)!;
const AAPL = offer("AAPLc");
const UBER = offer("UBERc");
const NEW_FEED = "0x1111111111111111111111111111111111111111";

/** Coinbase's response shape, with the given [token, feed] pairs. */
const official = (pairs: [string, string][]) =>
  new Response(JSON.stringify({ nav_feeds: pairs.map(([c, f]) => ({ contract_address: c, nav_feed_address: f })) }), {
    status: 200,
  });

const listed = async () => withNavFeed(listSpotBuyableOffers(), await navFeeds()).map((o) => o.symbol);

describe("parseNavFeeds", () => {
  it("maps token → feed, matching addresses case-insensitively", () => {
    const feeds = parseNavFeeds({
      nav_feeds: [{ contract_address: AAPL.address.toUpperCase().replace("0X", "0x"), nav_feed_address: AAPL.feedAddress }],
    })!;
    expect(feeds.get(AAPL.address.toLowerCase())).toBe(AAPL.feedAddress);
  });

  it("skips bad rows and rejects a bad body", () => {
    expect(parseNavFeeds({ nav_feeds: [{ contract_address: AAPL.address, nav_feed_address: "nope" }, {}] })!.size).toBe(0);
    expect(parseNavFeeds({ error: "x" })).toBeNull();
    expect(parseNavFeeds(null)).toBeNull();
  });
});

describe("listing gate", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    resetNavFeedsCache();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("lists a stock whose token is on Coinbase's feed list", async () => {
    fetchMock.mockResolvedValue(official([[AAPL.address, AAPL.feedAddress!]]));
    expect(await listed()).toEqual(["AAPLc"]);
  });

  it("hides a stock with no feed on the list", async () => {
    fetchMock.mockResolvedValue(official([[AAPL.address, AAPL.feedAddress!]]));
    expect(await listed()).not.toContain("UBERc");
    expect(await navFeedFor(UBER.address)).toBeNull();
  });

  it("lists a stock by itself once Coinbase adds its feed, and returns that feed", async () => {
    expect(UBER.feedAddress).toBeNull();
    fetchMock.mockResolvedValue(official([[AAPL.address, AAPL.feedAddress!], [UBER.address, NEW_FEED]]));
    expect(await listed()).toEqual(expect.arrayContaining(["AAPLc", "UBERc"]));
    expect(await navFeedFor(UBER.address)).toBe(NEW_FEED);
  });

  it("falls back to the catalog's feeds when the fetch fails", async () => {
    fetchMock.mockRejectedValue(new Error("timeout"));
    const withCatalogFeed = listSpotBuyableOffers().filter((o) => o.feedAddress).map((o) => o.symbol);
    expect(withCatalogFeed.length).toBeGreaterThan(0);
    expect(await listed()).toEqual(withCatalogFeed);
    expect(await listed()).not.toContain("UBERc");
  });

  it("falls back on an error status or an empty list too", async () => {
    fetchMock.mockResolvedValueOnce(new Response("down", { status: 503 }));
    expect((await navFeeds()).size).toBe(catalogNavFeeds().size);
    resetNavFeedsCache();
    fetchMock.mockResolvedValueOnce(official([]));
    expect((await navFeeds()).size).toBe(catalogNavFeeds().size);
  });

  it("caches the official list", async () => {
    fetchMock.mockResolvedValue(official([[AAPL.address, AAPL.feedAddress!]]));
    await navFeeds();
    await navFeeds();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
