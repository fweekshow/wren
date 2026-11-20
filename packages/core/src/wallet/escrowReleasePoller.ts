import { config } from "@/config/config.js";
import { WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";
import { startPollerJob, type PollerJobHandle } from "@/infra/queues/base.js";
import { acquireLock, releaseLock } from "@/state/conversationState.store.js";
import { logger } from "@/utils/logger.js";

import {
  PhoneEscrowAdapter,
  type PhoneEscrowPosition,
  type PhoneEscrowReleaseResult,
} from "./phoneEscrow.js";

export interface EscrowReleasePollerDeps {
  listPositions: () => Promise<PhoneEscrowPosition[]>;
  /** The recipient's connected embedded wallet, or null if they haven't connected. */
  getConnectedAddress: (phone: string) => Promise<string | null>;
  claim: (position: PhoneEscrowPosition) => Promise<boolean>;
  unclaim: (position: PhoneEscrowPosition) => Promise<void>;
  release: (
    position: PhoneEscrowPosition,
    address: string,
  ) => Promise<PhoneEscrowReleaseResult | null>;
  deliver: (phone: string, message: string) => Promise<boolean>;
  buildMessage: (result: PhoneEscrowReleaseResult) => string;
}

export interface EscrowReleaseTickResult {
  checked: number;
  released: number;
  delivered: number;
}

export function buildEscrowReleaseMessage(result: PhoneEscrowReleaseResult): string {
  return `💸 ${result.amount} ${result.tokenSymbol} was sent to you and is now in your Basemate wallet.`;
}

function defaultDeps(): Omit<EscrowReleasePollerDeps, "deliver"> {
  return {
    listPositions: () => PhoneEscrowAdapter.listUnreleasedPositions(),
    // Release only to the recipient's embedded Basemate wallet.
    getConnectedAddress: (phone) => WalletAdapter.getReceiveAddress(phone),
    claim: (position) => PhoneEscrowAdapter.claimForRelease(position),
    unclaim: (position) => PhoneEscrowAdapter.unclaimForRelease(position),
    release: (position, address) =>
      PhoneEscrowAdapter.releaseToWalletAddress({
        position,
        recipientAddress: address,
      }),
    buildMessage: buildEscrowReleaseMessage,
  };
}

/**
 * Reconciles phone-escrow deposits whose recipient has since connected a Base
 * Account, releasing the funds to them.
 *
 * The original release only fires once — at the instant the recipient connects
 * — so any deposit made *after* they connected (or after a transient failure)
 * would otherwise sit in the contract forever. This poller closes that gap.
 *
 * Each recipient is locked (`releasing`) before we touch the chain, so a release
 * is sent at most once per claimable balance even across overlapping ticks or
 * multiple instances. A no-op or failure rolls the lock back so a later tick can
 * retry.
 */
export class EscrowReleasePoller {
  private readonly deps: EscrowReleasePollerDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(deps: Partial<EscrowReleasePollerDeps> = {}) {
    const fallbackDeliver: EscrowReleasePollerDeps["deliver"] = async () => {
      logger.warn("⚠️ EscrowReleasePoller has no deliver fn — release DM dropped");
      return false;
    };
    this.deps = { ...defaultDeps(), deliver: fallbackDeliver, ...deps };
  }

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    if (!config.phoneEscrow.releaseEnabled) {
      logger.warn(
        "⚠️ EscrowReleasePoller not started — phone escrow release is disabled " +
          "(set PHONE_ESCROW_OPERATOR_PRIVATE_KEY to enable releases).",
      );
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    logger.info(
      `🔔 EscrowReleasePoller started (every ${Math.round(intervalMs / 1000)}s)`,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async startBullMq(intervalMs = 60_000): Promise<PollerJobHandle | null> {
    if (!config.phoneEscrow.releaseEnabled) {
      logger.warn(
        "⚠️ EscrowReleasePoller (BullMQ) not started — phone escrow release is disabled.",
      );
      return null;
    }
    return startPollerJob("escrow-release-poller", () => this.tickOnce(), intervalMs, {
      keepFailed: 500,
    });
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    const lockKey = "lock:escrow-release-poller";
    const acquired = await acquireLock(lockKey, 90_000);
    if (!acquired) return;
    this.running = true;
    try {
      await this.tickOnce();
    } catch (err) {
      logger.error(`❌ EscrowReleasePoller tick failed: ${(err as Error)?.message || err}`);
    } finally {
      this.running = false;
      await releaseLock(lockKey);
    }
  }

  /** Run one reconciliation pass. Exposed for tests. */
  async tickOnce(): Promise<EscrowReleaseTickResult> {
    const positions = await this.deps.listPositions();
    const result: EscrowReleaseTickResult = {
      checked: positions.length,
      released: 0,
      delivered: 0,
    };

    for (const position of positions) {
      // Can't release until the recipient has an embedded wallet to send to.
      const address = await this.deps.getConnectedAddress(position.phone);
      if (!address) continue;

      // Win the lock before touching the chain so funds release at most once.
      if (!(await this.deps.claim(position))) continue;

      try {
        const released = await this.deps.release(position, address);
        if (!released) {
          // Nothing was actually in the contract — free the lock for later.
          await this.deps.unclaim(position);
          continue;
        }
        result.released += 1;

        const ok = await this.deps.deliver(
          position.phone,
          this.deps.buildMessage(released),
        );
        if (ok) result.delivered += 1;
        else logger.warn(`⚠️ Escrow released for ${position.phone} but release DM returned false`);
      } catch (err) {
        // Roll the lock back so the next tick retries the release.
        await this.deps.unclaim(position).catch(() => {});
        logger.error(
          `❌ Escrow release for ${position.phone} failed: ${(err as Error)?.message || err}`,
        );
      }
    }

    return result;
  }
}
