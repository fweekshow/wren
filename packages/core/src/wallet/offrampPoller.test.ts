import { beforeEach, describe, expect, it, vi } from "vitest";

const adapter = vi.hoisted(() => ({
  expireStale: vi.fn(),
  listActive: vi.fn(),
  listTerminalUnnotified: vi.fn(),
  markNotified: vi.fn(),
}));
const refreshOfframp = vi.hoisted(() => vi.fn());

vi.mock("@/wallet/offrampSession.js", () => ({ OfframpSessionAdapter: adapter }));
vi.mock("@/wallet/offramp.js", () => ({
  refreshOfframp,
  OfframpValidationError: class OfframpValidationError extends Error {},
}));
vi.mock("@/infra/queues/base.js", () => ({ startPollerJob: vi.fn() }));
vi.mock("@/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const session = {
  id: "session-1",
  platform: "imessage",
  userKey: "+15550001111",
  requestedAmount: "10",
  sellAmount: "10",
  fiatTotal: "9.50",
  fiatCurrency: "USD",
  txHash: "0xabc",
  status: "success",
};

describe("OfframpStatusPoller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapter.expireStale.mockResolvedValue(0);
    adapter.listActive.mockResolvedValue([]);
    adapter.listTerminalUnnotified.mockResolvedValue([]);
    adapter.markNotified.mockResolvedValue(true);
  });

  it("scopes work to the channel platform and delivers a terminal receipt once", async () => {
    adapter.listTerminalUnnotified.mockResolvedValue([session]);
    const deliver = vi.fn().mockResolvedValue(true);
    const { OfframpStatusPoller, offrampDelivery } = await import("./offrampPoller.js");
    offrampDelivery.register("imessage", deliver);

    const result = await new OfframpStatusPoller("imessage").tickOnce();

    expect(adapter.listActive).toHaveBeenCalledWith("imessage");
    expect(adapter.listTerminalUnnotified).toHaveBeenCalledWith("imessage");
    expect(adapter.markNotified).toHaveBeenCalledWith("session-1");
    expect(deliver).toHaveBeenCalledWith(session, expect.stringMatching(/cash out complete/i));
    expect(result.delivered).toBe(1);
  });

  it("does not deliver when another tick already claimed notification", async () => {
    adapter.listTerminalUnnotified.mockResolvedValue([session]);
    adapter.markNotified.mockResolvedValue(false);
    const deliver = vi.fn().mockResolvedValue(true);
    const { OfframpStatusPoller, offrampDelivery } = await import("./offrampPoller.js");
    offrampDelivery.register("imessage", deliver);

    await new OfframpStatusPoller("imessage").tickOnce();

    expect(deliver).not.toHaveBeenCalled();
  });

  it("refreshes active sessions before selecting terminal notifications", async () => {
    const active = { ...session, status: "processing" };
    adapter.listActive.mockResolvedValue([active]);
    refreshOfframp.mockResolvedValue({ ...active, status: "success" });
    const { OfframpStatusPoller } = await import("./offrampPoller.js");

    const result = await new OfframpStatusPoller("imessage").tickOnce();

    expect(refreshOfframp).toHaveBeenCalledWith(active);
    expect(result.resolved).toBe(1);
  });
});
