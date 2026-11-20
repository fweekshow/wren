export interface WhatsappLivenessSnapshot {
  connected: boolean;
  lastConnectedAt: number | null;
  lastActivityAt: number | null;
  lastDisconnectedAt: number | null;
  reconnects: number;
}

const state: WhatsappLivenessSnapshot = {
  connected: false,
  lastConnectedAt: null,
  lastActivityAt: null,
  lastDisconnectedAt: null,
  reconnects: 0,
};

export const whatsappLiveness = {
  markConnected(): void {
    if (state.lastConnectedAt !== null) state.reconnects += 1;
    state.connected = true;
    state.lastConnectedAt = Date.now();
    state.lastActivityAt = Date.now();
  },
  markActivity(): void {
    state.lastActivityAt = Date.now();
  },
  markDisconnected(): void {
    state.connected = false;
    state.lastDisconnectedAt = Date.now();
  },
  snapshot(): WhatsappLivenessSnapshot {
    return { ...state };
  },
  isHealthy(graceMs = 60_000, now = Date.now()): boolean {
    if (state.connected) return true;
    if (state.lastConnectedAt === null || state.lastDisconnectedAt === null) return false;
    return now - state.lastDisconnectedAt < graceMs;
  },
};
