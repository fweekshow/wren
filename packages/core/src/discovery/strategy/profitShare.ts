import { createHash } from "node:crypto";

// import { StrategyRewardAdapter } from "@/discovery/adapters/strategyReward.adapter.js";
// import {
//   StrategySubscriptionAdapter,
//   type StrategySubscriptionRow,
// } from "@/discovery/adapters/strategySubscription.adapter.js";

/** Basis points per side: 1% creator + 1% platform = 100 bps each. */
export const STRATEGY_PROFIT_SHARE_BPS = 100;

export function followerWalletName(strategyId: string, followerInboxId: string): string {
  const hash = createHash("sha256")
    .update(`${strategyId}:${followerInboxId}`)
    .digest("hex")
    .slice(0, 28);
  return `sf-${hash}`;
}

export interface ProfitShareSplit {
  profitUsd: number;
  creatorShareUsd: number;
  platformShareUsd: number;
}

/** Compute 1%/1% split on incremental profit above high-water mark. */
export function computeProfitShare(
  previousHwm: number,
  currentEquity: number,
): ProfitShareSplit & { incrementalProfit: number; newHwm: number } {
  const newHwm = Math.max(previousHwm, currentEquity);
  const incrementalProfit = Math.max(0, newHwm - previousHwm);
  const creatorShareUsd = (incrementalProfit * STRATEGY_PROFIT_SHARE_BPS) / 10_000;
  const platformShareUsd = (incrementalProfit * STRATEGY_PROFIT_SHARE_BPS) / 10_000;
  return {
    incrementalProfit,
    newHwm,
    profitUsd: incrementalProfit,
    creatorShareUsd,
    platformShareUsd,
  };
}

/** Settle profit-share for a follower subscription when equity increases. */
// export async function settleFollowerProfitShare(input: {
//   strategyId: string;
//   creatorWallet: string;
//   subscription: StrategySubscriptionRow;
//   currentEquityUsd: number;
// }): Promise<ProfitShareSplit | null> {
//   const split = computeProfitShare(
//     input.subscription.high_water_mark_usd,
//     input.currentEquityUsd,
//   );
//   if (split.incrementalProfit <= 0) return null;

//   await StrategyRewardAdapter.record({
//     strategyId: input.strategyId,
//     subscriptionId: input.subscription.id,
//     creatorWallet: input.creatorWallet,
//     followerWallet: input.subscription.follower_wallet,
//     profitUsd: split.profitUsd,
//     creatorShareUsd: split.creatorShareUsd,
//     platformShareUsd: split.platformShareUsd,
//   });

//   await StrategySubscriptionAdapter.updateHighWaterMark(
//     input.subscription.id,
//     split.newHwm,
//   );

//   return split;
// }
