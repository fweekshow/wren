/**
 * Proactive creator notifications when a LIVE strategy can't execute because its
 * Basemate (custodial) wallet is out of funds. The runner only logged a warning
 * before, so a "live" strategy could silently never trade. This fires a single
 * XMTP DM per failure state and re-arms once the strategy executes again — it
 * never spams on every runner tick.
 *
 * Wired up by DiscoveryPlugin.onInit via setStrategyExecFailureNotifier, mirroring
 * the LossStreakNotifier pattern in strategyWiki.ts.
 */

export type StrategyFundingIssue = "no_usdc" | "no_gas";

export interface StrategyExecFailureNotice {
  strategyId: string;
  strategyName: string;
  creatorInboxId: string;
  creatorWallet: string | null;
  walletAddress: string | null;
  issue: StrategyFundingIssue;
  /** USDC margin the strategy needs per trade (for the "top up $X" copy). */
  marginUsdc: number;
}

type StrategyExecFailureNotifier = (notice: StrategyExecFailureNotice) => Promise<void>;

let notifier: StrategyExecFailureNotifier | null = null;

/** Wire up creator delivery (XMTP DM). Registered by DiscoveryPlugin.onInit. */
export function setStrategyExecFailureNotifier(fn: StrategyExecFailureNotifier): void {
  notifier = fn;
}

/**
 * Classify an executor error string into a funding issue we can notify on.
 * Returns null for errors that aren't a user-fixable funding problem (transient
 * RPC errors, etc.) so we don't nag users about things they can't fix.
 */
export function classifyFundingError(error: string | undefined | null): StrategyFundingIssue | null {
  if (!error) return null;
  const e = error.toLowerCase();
  if (e.includes("no eth for gas") || e.includes("insufficient funds for gas") || e.includes("has no eth")) {
    return "no_gas";
  }
  if (
    e.includes("transfer amount exceeds balance") ||
    e.includes("insufficient balance") ||
    e.includes("erc20")
  ) {
    return "no_usdc";
  }
  return null;
}

// Strategies we've already DM'd about their CURRENT funding failure, keyed by
// `${strategyId}:${issue}`. Cleared when the strategy executes successfully, so a
// fresh failure later notifies again (once).
const notified = new Set<string>();

/** Clear the funding-failure flags for a strategy after a successful execution. */
export function clearExecFailureNotice(strategyId: string): void {
  notified.delete(`${strategyId}:no_usdc`);
  notified.delete(`${strategyId}:no_gas`);
}

/**
 * Best-effort: notify the creator once when their live strategy hits a funding
 * failure. Re-arms only after clearExecFailureNotice (a successful trade), so it
 * never fires on every tick. Never throws.
 */
export async function maybeNotifyExecFailure(notice: Omit<StrategyExecFailureNotice, "issue"> & {
  error: string | undefined | null;
}): Promise<void> {
  const issue = classifyFundingError(notice.error);
  if (!issue || !notifier) return;

  const key = `${notice.strategyId}:${issue}`;
  if (notified.has(key)) return;
  notified.add(key);

  try {
    await notifier({
      strategyId: notice.strategyId,
      strategyName: notice.strategyName,
      creatorInboxId: notice.creatorInboxId,
      creatorWallet: notice.creatorWallet,
      walletAddress: notice.walletAddress,
      marginUsdc: notice.marginUsdc,
      issue,
    });
  } catch {
    // Delivery is best-effort; keep the flag set so we don't retry-spam.
  }
}
