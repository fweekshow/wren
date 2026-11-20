import { beforeEach, describe, expect, it, vi } from "vitest";

const sendCalls = vi.hoisted(() => vi.fn());
const signTypedData = vi.hoisted(() => vi.fn());
const flashSubmitOrder = vi.hoisted(() => vi.fn());
const flashGetOrder = vi.hoisted(() => vi.fn());

vi.mock("@/config/config.js", () => ({
  config: { flash: { integratorFeeBps: "", attributionCode: "" } },
}));

vi.mock("@/wallet/embeddedWallet.js", () => ({
  EmbeddedWalletAdapter: { sendCalls, signTypedData },
}));

vi.mock("./client.js", () => ({
  FlashApiError: class FlashApiError extends Error {},
  flashSubmitOrder,
  flashGetOrder,
}));

vi.mock("@/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const typed = JSON.stringify({
  domain: { name: "Permit2", chainId: "8453", verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3" },
  types: { PermitSingle: [{ name: "details", type: "PermitDetails" }] },
  primaryType: "PermitSingle",
  message: { spender: "0xflash" },
});

describe("placeFlashOrder Permit2", () => {
  beforeEach(() => {
    sendCalls.mockReset();
    signTypedData.mockReset();
    flashSubmitOrder.mockReset();
    flashGetOrder.mockReset();
    signTypedData
      .mockResolvedValueOnce({ signature: "0xpermit" })
      .mockResolvedValueOnce({ signature: "0xorder" });
    flashSubmitOrder.mockResolvedValue({ orderId: "ord_1" });
    flashGetOrder.mockResolvedValue({ orderId: "ord_1", status: "ORDER_STATUS_FILLED" });
  });

  it("signs permitTypedData and echoes it on submit", async () => {
    const { placeFlashOrder } = await import("./placeOrder.js");
    await placeFlashOrder({
      cdpUserId: "user-1",
      prepared: {
        quoteId: "q1",
        orderType: "market",
        side: "sell",
        targetAsset: "0x07E61D8a4e197dfC269e90D7ECe1dF0D26702bA3",
        contraAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        targetSymbol: "BASEMATE",
        contraSymbol: "USDC",
        qty: "5",
        funderAddress: "0x1111111111111111111111111111111111111111",
        orderTypedData: typed,
        approveTx: null,
        permitTypedData: typed,
        estimatedFeeNotional: "0",
        fromNotional: "5",
        toNotional: "5",
        fromAmount: "5",
        toAmount: "5",
      },
    });

    expect(signTypedData).toHaveBeenCalledTimes(2);
    const submit = flashSubmitOrder.mock.calls[0][0];
    expect(submit.evmPermitTypedData).toBe(typed);
    expect(submit.evmPermitSignature).toBe("0xpermit");
    expect(submit.userSignature).toBe("0xorder");
    expect(sendCalls).not.toHaveBeenCalled();
  });
});
