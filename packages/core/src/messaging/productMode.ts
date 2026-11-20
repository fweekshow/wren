import type { ImessageIntentAction } from "./intentEngine.js";

export type ImessageProductMode = "trading" | "money";

const TRADING_ACTIONS = new Set<ImessageIntentAction>([
  "swap",
  "perp_trade",
  "yield",
]);

const MONEY_ACTIONS = new Set<ImessageIntentAction>([
  "send_token",
  "main_wallet_fund",
  "main_wallet_transfer",
  "main_wallet_offramp",
]);

export function productModeForIntentAction(
  action: ImessageIntentAction,
): ImessageProductMode | undefined {
  if (TRADING_ACTIONS.has(action)) return "trading";
  if (MONEY_ACTIONS.has(action)) return "money";
  return undefined;
}

export function productModeForPendingState(state: {
  pendingAmountChoice?: boolean;
  pendingFundAmount?: boolean;
  pendingOnramp?: boolean;
  pendingPerp?: boolean;
  pendingSwapDraft?: boolean;
  pendingYieldChoice?: boolean;
}): ImessageProductMode | undefined {
  if (
    state.pendingAmountChoice ||
    state.pendingPerp ||
    state.pendingSwapDraft ||
    state.pendingYieldChoice
  ) {
    return "trading";
  }
  if (state.pendingFundAmount || state.pendingOnramp) return "money";
  return undefined;
}
