/**
 * Liveness state for the iMessage outbound transport (Spectrum SDK connection).
 *
 * The bot's ability to reply depends on a live `spectrum-ts` outbound
 * connection. The Express server can be up while the SDK is disconnected,
 * leaving the bot able to receive webhooks but unable to send replies.
 * This module is the single source of truth the reconnect loop writes to
 * and the `/health` endpoint reads, so deployments can tell the difference.
 *
 * Inbound reception health is implicit — as long as the Spectrum webhook
 * worker can reach the `/spectrum-webhook` HTTP endpoint and the process is
 * running, inbound messages are queued even while the outbound SDK reconnects.
 */
export interface ImessageLivenessSnapshot {
  /** True while the outbound SDK is connected and ready to send. */
  connected: boolean;
  /** Epoch ms of the most recent successful (re)connect, or null before first connect. */
  lastConnectedAt: number | null;
  /** Epoch ms of the last message activity (webhook processed), or null. */
  lastActivityAt: number | null;
  /** Epoch ms of the last time the outbound connection dropped, or null. */
  lastDisconnectedAt: number | null;
  /** How many times the outbound transport has reconnected after the initial connect. */
  reconnects: number;
}

const state: ImessageLivenessSnapshot = {
  connected:          false,
  lastConnectedAt:    null,
  lastActivityAt:     null,
  lastDisconnectedAt: null,
  reconnects:         0,
};

export const imessageLiveness = {
  markConnected(): void {
    if (state.lastConnectedAt !== null) state.reconnects += 1;
    state.connected       = true;
    state.lastConnectedAt = Date.now();
    state.lastActivityAt  = Date.now();
  },
  markActivity(): void {
    state.lastActivityAt = Date.now();
  },
  markDisconnected(): void {
    state.connected           = false;
    state.lastDisconnectedAt  = Date.now();
  },
  snapshot(): ImessageLivenessSnapshot {
    return { ...state };
  },
  /** Milliseconds the outbound transport has been continuously disconnected, or 0 if connected/never-started. */
  disconnectedFor(now = Date.now()): number {
    if (state.connected || state.lastDisconnectedAt === null) return 0;
    return now - state.lastDisconnectedAt;
  },
  /**
   * Healthy while connected or only briefly disconnected after a successful
   * first connection. Before the outbound transport has ever connected, the
   * service is not ready to accept iMessage traffic.
   */
  isHealthy(graceMs = 60_000, now = Date.now()): boolean {
    if (state.connected) return true;
    if (state.lastConnectedAt === null) return false;
    if (state.lastDisconnectedAt === null) return false;
    return now - state.lastDisconnectedAt < graceMs;
  },
};
