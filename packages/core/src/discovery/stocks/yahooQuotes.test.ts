import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { candleCloseAt, parseYahooChart, previousClose, resetYahooCache, yahooChart, yahooTicker } from "./yahooQuotes.js";

// KO, range=5d interval=1d, saved on Thanksgiving 2026 (market closed).
// Last session Nov 25 closed at 97.59; Nov 24 closed at 97.62.
const KO = JSON.parse(readFileSync(new URL("./yahooChart.KO.fixture.json", import.meta.url), "utf8"));

/** ms for an ET wall-clock time in November (EST, UTC-5). */
const et = (day: number, hh: number, mm = 0) => Date.UTC(2026, 10, day, hh + 5, mm);

describe("yahooTicker", () => {
  it("strips the c suffix", () => {
    expect(yahooTicker("UBERc")).toBe("UBER");
    expect(yahooTicker("KOc")).toBe("KO");
    expect(yahooTicker("AAOIc")).toBe("AAOI");
  });

  it("maps class shares to Yahoo's dash", () => {
    expect(yahooTicker("BRK.Bc")).toBe("BRK-B");
  });
});

describe("parseYahooChart", () => {
  it("reads price, time and daily closes", () => {
    const chart = parseYahooChart(KO)!;
    expect(chart.price).toBe(97.59);
    expect(chart.marketTime).toBe(et(25, 16, 0) + 2000);
    expect(chart.candles).toHaveLength(5);
    expect(chart.candles[0][0]).toBe(et(19, 9, 30));
    expect(chart.candles[4][1]).toBeCloseTo(97.59, 2);
  });

  it("drops null closes", () => {
    const chart = parseYahooChart({
      chart: { result: [{ meta: { regularMarketPrice: 10, regularMarketTime: 1 }, timestamp: [1, 2, 3], indicators: { quote: [{ close: [9, null, 11] }] } }] },
    })!;
    expect(chart.candles).toEqual([[1000, 9], [3000, 11]]);
  });

  it("returns null for errors", () => {
    expect(parseYahooChart({ chart: { result: null, error: { code: "Not Found" } } })).toBeNull();
    expect(parseYahooChart(null)).toBeNull();
  });
});

describe("previousClose", () => {
  const candles: [number, number][] = [
    [et(23, 9, 30), 100],
    [et(24, 9, 30), 101],
    [et(25, 9, 30), 102],
  ];

  it("is the second-to-last close while today's session has a candle", () => {
    expect(previousClose(candles, et(25, 11, 15))).toEqual({ at: et(24, 16), price: 101 });
    // After the close too.
    expect(previousClose(candles, et(25, 16))).toEqual({ at: et(24, 16), price: 101 });
  });

  it("is the last close when today has no candle yet", () => {
    // Pre-market, before Yahoo opens today's candle.
    expect(previousClose(candles, et(26, 8))).toEqual({ at: et(25, 16), price: 102 });
    // Late evening ET is still the same New York day.
    expect(previousClose(candles, et(26, 23, 30))).toEqual({ at: et(25, 16), price: 102 });
  });

  it("is the last session's close on a holiday (saved KO, Thanksgiving)", () => {
    const chart = parseYahooChart(KO)!;
    const prev = previousClose(chart.candles, et(26, 12))!;
    expect(prev.price).toBeCloseTo(97.59, 2);
    expect(prev.at).toBe(et(25, 16));
    // And the day before, once Nov 25 is "today".
    expect(previousClose(chart.candles, et(25, 12))!.price).toBeCloseTo(97.62, 2);
  });

  it("ignores chartPreviousClose (the close before the whole range)", () => {
    expect(KO.chart.result[0].meta.chartPreviousClose).toBe(98.09);
    const chart = parseYahooChart(KO)!;
    expect(previousClose(chart.candles, et(26, 12))!.price).not.toBe(98.09);
  });

  it("is null without an earlier day", () => {
    expect(previousClose([], et(25, 12))).toBeNull();
    expect(previousClose([[et(25, 9, 30), 5]], et(25, 12))).toBeNull();
  });
});

describe("candleCloseAt", () => {
  it("puts hourly closes at the end of the hour and daily at 4pm ET", () => {
    expect(candleCloseAt(et(25, 9, 30), "1h")).toBe(et(25, 10, 30));
    expect(candleCloseAt(et(25, 9, 30), "1d")).toBe(et(25, 16));
  });
});

describe("yahooChart", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    resetYahooCache();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("fetches the mapped ticker with a browser UA and caches it", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(KO), { status: 200 }));
    const a = await yahooChart("BRK.Bc");
    const b = await yahooChart("BRK.Bc");
    expect(a?.price).toBe(97.59);
    expect(b).toBe(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://query1.finance.yahoo.com/v8/finance/chart/BRK-B?range=5d&interval=1d");
    expect(init.headers["User-Agent"]).toMatch(/^Mozilla\/5\.0/);
  });

  it("returns null on failure and cools off after a 429", async () => {
    fetchMock.mockResolvedValueOnce(new Response("Too Many Requests", { status: 429 }));
    expect(await yahooChart("KOc")).toBeNull();
    expect(await yahooChart("UBERc")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns null when fetch throws", async () => {
    fetchMock.mockRejectedValue(new Error("timeout"));
    expect(await yahooChart("KOc")).toBeNull();
  });
});
