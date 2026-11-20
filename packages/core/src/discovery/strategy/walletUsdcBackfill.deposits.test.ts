import { describe, expect, it } from "vitest";

import {
  matchTradePnlFromUsdcFlows,
  type StrategyTradeBackfillRow,
  type UsdcTransfer,
} from "./walletUsdcBackfill.js";

// Mirror the contract addresses the backfill keys off of.
const AVANTIS_TRADING_STORAGE = "0x8a311d7048c35985aa31c131b9a13e03a5f7422d";
const AVANTIS_TRADING_PAYOUT = "0xe9fb8c70af1b99f2baaa07aa926fcf3d237348dd";
const WALLET = "0x1111111111111111111111111111111111111111";
const RANDOM_EOA = "0x9999999999999999999999999999999999999999"; // a depositor / withdrawal target

let block = 1n;
let logIdx = 0;

function open(amountUsd: number, txHash = `0xopen${amountUsd}`): UsdcTransfer {
  return { txHash, blockNumber: block++, logIndex: logIdx++, from: WALLET, to: AVANTIS_TRADING_STORAGE, amountUsd };
}
function close(amountUsd: number, txHash = `0xclose${amountUsd}`): UsdcTransfer {
  return { txHash, blockNumber: block++, logIndex: logIdx++, from: AVANTIS_TRADING_PAYOUT, to: WALLET, amountUsd };
}
function deposit(amountUsd: number): UsdcTransfer {
  return { txHash: `0xdep${amountUsd}`, blockNumber: block++, logIndex: logIdx++, from: RANDOM_EOA, to: WALLET, amountUsd };
}
function withdrawal(amountUsd: number): UsdcTransfer {
  return { txHash: `0xwd${amountUsd}`, blockNumber: block++, logIndex: logIdx++, from: WALLET, to: RANDOM_EOA, amountUsd };
}
function trade(id: string, collateral: number, txHash: string | null): StrategyTradeBackfillRow {
  return { id, strategy_id: "s1", tx_hash: txHash, collateral_usdc: collateral, created_at: new Date(2026, 5, 24, 0, Number(id.replace(/\D/g, "")) || 0) };
}

describe("matchTradePnlFromUsdcFlows — deposit/withdrawal proofness", () => {
  it("computes win (close - open) and ignores an interleaved deposit + withdrawal", () => {
    block = 1n;
    logIdx = 0;
    const transfers: UsdcTransfer[] = [
      open(100, "0xtradetx"),
      deposit(5_000), // user funds the wallet — must NOT be seen as profit
      close(160, "0xclosetx"), // +$60 win
      withdrawal(2_000), // user pulls funds — must NOT be seen as a loss/open
    ];
    const pnl = matchTradePnlFromUsdcFlows([trade("t1", 100, "0xtradetx")], transfers, WALLET);
    expect(pnl.get("t1")).toBeCloseTo(60, 6);
  });

  it("a deposit alone (no Avantis flows) yields zero matches — never a phantom win", () => {
    block = 1n;
    logIdx = 0;
    const transfers: UsdcTransfer[] = [deposit(10_000), withdrawal(3_000)];
    const pnl = matchTradePnlFromUsdcFlows([trade("t1", 100, "0xtradetx")], transfers, WALLET);
    expect(pnl.size).toBe(0);
  });

  it("computes a loss when the payout is smaller than the posted margin", () => {
    block = 1n;
    logIdx = 0;
    const transfers: UsdcTransfer[] = [open(100, "0xa"), close(30, "0xb")]; // -$70
    const pnl = matchTradePnlFromUsdcFlows([trade("t1", 100, "0xa")], transfers, WALLET);
    expect(pnl.get("t1")).toBeCloseTo(-70, 6);
  });

  it("FIFO-pairs two trades by collateral when tx hashes are missing", () => {
    block = 1n;
    logIdx = 0;
    const transfers: UsdcTransfer[] = [
      open(50),
      deposit(1_000),
      close(75), // +25 for the $50 trade
      open(200),
      close(150), // -50 for the $200 trade
    ];
    const pnl = matchTradePnlFromUsdcFlows(
      [trade("t1", 50, null), trade("t2", 200, null)],
      transfers,
      WALLET,
    );
    expect(pnl.get("t1")).toBeCloseTo(25, 6);
    expect(pnl.get("t2")).toBeCloseTo(-50, 6);
  });

  it("does not pair a close that precedes its open", () => {
    block = 1n;
    logIdx = 0;
    const stray = close(80); // close with no matching prior open
    const transfers: UsdcTransfer[] = [stray, open(100, "0xopen")];
    const pnl = matchTradePnlFromUsdcFlows([trade("t1", 100, "0xopen")], transfers, WALLET);
    // open matched but no later close → no pnl recorded
    expect(pnl.size).toBe(0);
  });
});
