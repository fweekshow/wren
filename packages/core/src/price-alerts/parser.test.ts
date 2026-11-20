import { describe, expect, it } from "vitest";

import { parseAlertIntent, parseAlertIntents } from "./parser.js";

describe("parseAlertIntent", () => {
  it("parses a simple price alert with $ target", () => {
    const intent = parseAlertIntent("set a price alert for ETH at $1700");
    expect(intent).toEqual({
      tokenQuery: "ETH",
      contractAddress: null,
      metric: "price_usd",
      targetValue: 1700,
      direction: null,
    });
  });

  it("parses a market-cap alert with a magnitude suffix", () => {
    const intent = parseAlertIntent("alert me when $BASEMATE hits 1M MC");
    expect(intent).toMatchObject({
      tokenQuery: "BASEMATE",
      contractAddress: null,
      metric: "market_cap_usd",
      targetValue: 1_000_000,
      direction: null,
    });
  });

  it("detects an explicit below direction", () => {
    const intent = parseAlertIntent("notify me when BTC goes below 90000");
    expect(intent).toMatchObject({
      tokenQuery: "BTC",
      metric: "price_usd",
      targetValue: 90000,
      direction: "below",
    });
  });

  it("parses multiple BTC thresholds from one alert request", () => {
    const intents = parseAlertIntents("set an alert when BTC hits 60000 or 61000");
    expect(intents).toEqual([
      {
        tokenQuery: "BTC",
        contractAddress: null,
        metric: "price_usd",
        targetValue: 60000,
        direction: null,
      },
      {
        tokenQuery: "BTC",
        contractAddress: null,
        metric: "price_usd",
        targetValue: 61000,
        direction: null,
      },
    ]);
  });

  it("captures a contract address and a sub-dollar target", () => {
    const addr = "0x1234567890abcdef1234567890abcdef12345678";
    const intent = parseAlertIntent(`alert ${addr} at 0.05`);
    expect(intent).toMatchObject({
      contractAddress: addr,
      tokenQuery: addr,
      targetValue: 0.05,
      metric: "price_usd",
    });
  });

  it("handles comma-formatted numbers", () => {
    const intent = parseAlertIntent("alert me when ETH hits $4,200");
    expect(intent?.targetValue).toBe(4200);
  });

  it("ignores a leading greeting before an alert request", () => {
    const intent = parseAlertIntent("Yo set a price alert when Bitcoin hits 70k");
    expect(intent).toMatchObject({
      tokenQuery: "BITCOIN",
      metric: "price_usd",
      targetValue: 70_000,
      direction: null,
    });
  });

  it("prefers the asset near the target phrase over earlier chatter", () => {
    const intent = parseAlertIntent("hey alert me when BTC goes below 90000");
    expect(intent).toMatchObject({
      tokenQuery: "BTC",
      targetValue: 90_000,
      direction: "below",
    });
  });

  it("returns null when there is no alert verb", () => {
    expect(parseAlertIntent("what's the price of eth right now?")).toBeNull();
  });

  it("returns null when there is no number", () => {
    expect(parseAlertIntent("alert me about eth")).toBeNull();
  });

  it("returns null for unrelated chatter", () => {
    expect(parseAlertIntent("gm, how is everyone doing")).toBeNull();
  });
});
