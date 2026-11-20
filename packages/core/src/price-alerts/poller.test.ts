import { describe, expect, it, vi } from "vitest";

vi.mock("@/discovery/adapters/priceAlert.adapter.js", () => ({
  PriceAlertAdapter: {},
}));

import type { PriceAlertRow } from "@/discovery/adapters/priceAlert.adapter.js";

import { PriceAlertPoller } from "./poller.js";

function alertRow(overrides: Partial<PriceAlertRow> = {}): PriceAlertRow {
  return {
    id: 1,
    platform: "xmtp",
    user_key: "inbox-1",
    dm_target: null,
    source_conversation_id: "conv-1",
    source_is_group: false,
    token_source: "coingecko",
    token_id: "ethereum",
    token_address: null,
    chain_id: null,
    symbol: "ETH",
    name: null,
    metric: "price_usd",
    target_value: "4000",
    direction: "above",
    current_value_at_create: "1800",
    status: "pending",
    created_at: new Date(),
    triggered_at: null,
    last_checked_at: null,
    ...overrides,
  };
}

describe("PriceAlertPoller.tickOnce", () => {
  it("marks an alert triggered BEFORE delivering it", async () => {
    const order: string[] = [];
    const poller = new PriceAlertPoller({
      listPending: async () => [alertRow()],
      markTriggered: async () => {
        order.push("markTriggered");
      },
      markFailed: async () => {},
      fetchQuote: async () => ({ priceUsd: 4200, marketCapUsd: null }),
      deliver: async () => {
        order.push("deliver");
        return true;
      },
      buildMessage: () => "ALERT",
    });

    const result = await poller.tickOnce();
    expect(result).toEqual({ checked: 1, triggered: 1, delivered: 1 });
    expect(order).toEqual(["markTriggered", "deliver"]);
  });

  it("does not trigger when the target has not been crossed", async () => {
    const markTriggered = vi.fn(async () => {});
    const deliver = vi.fn(async () => true);
    const poller = new PriceAlertPoller({
      listPending: async () => [alertRow()],
      markTriggered,
      markFailed: async () => {},
      fetchQuote: async () => ({ priceUsd: 1900, marketCapUsd: null }),
      deliver,
      buildMessage: () => "ALERT",
    });

    const result = await poller.tickOnce();
    expect(result.triggered).toBe(0);
    expect(markTriggered).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("fetches each unique token only once per pass", async () => {
    const fetchQuote = vi.fn(async () => ({ priceUsd: 4200, marketCapUsd: null }));
    const poller = new PriceAlertPoller({
      listPending: async () => [
        alertRow({ id: 1 }),
        alertRow({ id: 2 }),
      ],
      markTriggered: async () => {},
      markFailed: async () => {},
      fetchQuote,
      deliver: async () => true,
      buildMessage: () => "ALERT",
    });

    await poller.tickOnce();
    expect(fetchQuote).toHaveBeenCalledTimes(1);
  });

  it("still counts as triggered (one-time) when delivery fails", async () => {
    const markTriggered = vi.fn(async () => {});
    const poller = new PriceAlertPoller({
      listPending: async () => [alertRow()],
      markTriggered,
      markFailed: async () => {},
      fetchQuote: async () => ({ priceUsd: 4200, marketCapUsd: null }),
      deliver: async () => false,
      buildMessage: () => "ALERT",
    });

    const result = await poller.tickOnce();
    expect(result.triggered).toBe(1);
    expect(result.delivered).toBe(0);
    expect(markTriggered).toHaveBeenCalledOnce();
  });
});
