import { startPollerJob, type PollerJobHandle } from "@/infra/queues/base.js";
import { acquireLock, releaseLock } from "@/state/conversationState.store.js";
import { logger } from "@/utils/logger.js";

import {
  WalletSetupSessionAdapter,
  type PendingWelcomeSession,
} from "./walletSetupSession.js";

/**
 * Canonical first-run welcome DM. Pushed proactively right after a user
 * finishes signup on the web — they don't have to text first. The two bullets
 * teach the exact next actions (the "what do I do?" cold-start fix).
 */
export const WELCOME_DM_COPY = [
  "you're all set 🎉 two ways to start:",
  '• add cash — just say "deposit $20"',
  "• send to a friend — share their contact card with me and I'll walk you through it",
].join("\n");

export interface WalletWelcomePollerDeps {
  listPending: () => Promise<PendingWelcomeSession[]>;
  /** Claim by senderId so the DM fires at most once per user, not per session. */
  claim: (senderId: string) => Promise<boolean>;
  unclaim: (senderId: string) => Promise<void>;
  deliver: (phone: string, message: string) => Promise<boolean>;
  message: string;
}

export interface WalletWelcomeTickResult {
  checked: number;
  delivered: number;
}

function defaultDeps(): Omit<WalletWelcomePollerDeps, "deliver"> {
  return {
    listPending: () => WalletSetupSessionAdapter.listPendingWelcomes(),
    claim: (token) => WalletSetupSessionAdapter.claimWelcome(token),
    unclaim: (token) => WalletSetupSessionAdapter.unclaimWelcome(token),
    message: WELCOME_DM_COPY,
  };
}

/**
 * Sends the proactive welcome DM once per completed signup session. Signup is
 * persisted by the web `/wallet/connect` flow (which sets `completed_at`), so
 * the agent detects newly-completed sessions here and DMs the user. Each token
 * is claimed (welcome_sent_at) before delivery so the DM fires at most once,
 * even across overlapping ticks or multiple instances; a delivery failure rolls
 * the claim back for a later retry.
 */
export class WalletWelcomePoller {
  private readonly deps: WalletWelcomePollerDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(deps: Partial<WalletWelcomePollerDeps> = {}) {
    const fallbackDeliver: WalletWelcomePollerDeps["deliver"] = async () => {
      logger.warn("⚠️ WalletWelcomePoller has no deliver fn — welcome DM dropped");
      return false;
    };
    this.deps = { ...defaultDeps(), deliver: fallbackDeliver, ...deps };
  }

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    logger.info(`🔔 WalletWelcomePoller started (every ${Math.round(intervalMs / 1000)}s)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async startBullMq(intervalMs = 30_000): Promise<PollerJobHandle | null> {
    return startPollerJob("wallet-welcome-poller", () => this.tickOnce(), intervalMs, {
      keepFailed: 500,
    });
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    const lockKey = "lock:wallet-welcome-poller";
    const acquired = await acquireLock(lockKey, 60_000);
    if (!acquired) return;
    this.running = true;
    try {
      await this.tickOnce();
    } catch (err) {
      logger.error(`❌ WalletWelcomePoller tick failed: ${(err as Error)?.message || err}`);
    } finally {
      this.running = false;
      await releaseLock(lockKey);
    }
  }

  /** Run one pass. Exposed for tests. */
  async tickOnce(): Promise<WalletWelcomeTickResult> {
    const pending = await this.deps.listPending();
    const result: WalletWelcomeTickResult = { checked: pending.length, delivered: 0 };

    for (const session of pending) {
      // Claim the whole sender before delivering so the DM fires at most once
      // per user, even with multiple completed signup sessions.
      if (!(await this.deps.claim(session.senderId))) continue;
      try {
        const ok = await this.deps.deliver(session.senderId, this.deps.message);
        if (ok) {
          result.delivered += 1;
        } else {
          // Delivery reported failure — roll the claim back for a later retry.
          await this.deps.unclaim(session.senderId);
        }
      } catch (err) {
        await this.deps.unclaim(session.senderId).catch(() => {});
        logger.error(
          `❌ Welcome DM for ${session.senderId} failed: ${(err as Error)?.message || err}`,
        );
      }
    }

    return result;
  }
}
