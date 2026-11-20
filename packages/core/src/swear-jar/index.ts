import { effect, imessage } from "spectrum-ts/providers/imessage";

import { config } from "@/config/config.js";
import { WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";
import {
  isImessageMentioned,
  removeImessageMention,
} from "@/imessage/groupEngagement.js";
import type { GroupParticipant } from "@/messaging/utils/groupTag.utils.js";
import { logger } from "@/utils/logger.js";
import { WalletSetupSessionAdapter } from "@/wallet/walletSetupSession.js";

import { setAlexanderGroupAvatar } from "./appearance.js";
import {
  classifyAlexander,
  hasBrainCue,
  resolveArmedFastPath,
  type BrainContext,
  type BrainIntent,
} from "./brain.js";
import {
  matchHelp,
  matchOff,
  matchOn,
  matchOptIn,
  matchOptOut,
  normalizeCommand,
} from "./commands.js";
import {
  BURST_COOLDOWN_MS,
  SETTLE_CONFIRM_MS,
  SWEAR_FINE_USD,
  SWEAR_JAR_BRAIN,
  SWEAR_JAR_ENABLED,
} from "./constants.js";
import {
  copyAlreadyArmed,
  copyAlreadyOptedIn,
  copyArm,
  copyArmNoDelegation,
  copyCatchBroke,
  copyCatchBurst,
  copyCatchFunded,
  copyCatchNoWallet,
  copyCatchOptedOut,
  copyDisarm,
  copyDispute,
  copyEmptySettle,
  copyEnvOff,
  copyHelp,
  copyIouCap,
  copyNahEmpty,
  copyOptInNeedDelegation,
  copyOptInNeedWallet,
  copyOptInReady,
  copyOptOut,
  copySecrets,
  copySettle,
  copySettleConfirm,
  copyStandings,
  jarName,
} from "./copy.js";
import { hasSwearCue, judgeSwear } from "./judge.js";
import {
  collectFine,
  isDelegationLive,
  refundLatestFine,
  settleToWinner,
} from "./payout.js";
import { getOrCreateGroupPot } from "./pot.js";
import {
  armJar,
  biggestSinner,
  claimJarForSettle,
  countPaidFines,
  countPendingIous,
  disarmJar,
  dismissPendingIous,
  getActiveJar,
  getLatestPaidFineForSwearer,
  getStandings,
  insertFine,
  isJarArmed,
  markJarSettled,
  getRecentFineAt,
  pickWinner,
  restoreJarActive,
  touchActivity,
  upsertRosterMember,
  type SwearJarRow,
} from "./store.js";

export type SwearJarSend = (content: unknown) => Promise<unknown>;

/** Group space from Spectrum — avatar is optional sugar. */
export type SwearJarSpace = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  avatar?: (...args: any[]) => Promise<void>;
  [key: string]: unknown;
};

const lastSlamAt = new Map<string, number>();

type PendingSettleConfirm = {
  askedAt: number;
  potUsd: number;
  winnerName: string;
};
const pendingSettleConfirm = new Map<string, PendingSettleConfirm>();

function clearSettleConfirm(conversationId: string): void {
  pendingSettleConfirm.delete(conversationId);
}

function settleConfirmLive(conversationId: string): PendingSettleConfirm | null {
  const pending = pendingSettleConfirm.get(conversationId);
  if (!pending) return null;
  if (Date.now() - pending.askedAt > SETTLE_CONFIRM_MS) {
    pendingSettleConfirm.delete(conversationId);
    return null;
  }
  return pending;
}

async function connectUrl(senderId: string): Promise<string> {
  try {
    const token = await WalletSetupSessionAdapter.create(senderId);
    const url = new URL(`${config.payPage.origin}/wallet/connect`);
    url.searchParams.set("s", token);
    return url.toString();
  } catch {
    return `${config.payPage.origin}/app`;
  }
}

async function sendPlain(send: SwearJarSend, text: string): Promise<void> {
  if (!text.trim()) return;
  await send(text);
}

async function sendSlam(send: SwearJarSend, text: string): Promise<void> {
  try {
    await send(effect(text, imessage.effect.message.slam));
  } catch (err) {
    logger.warn({ err }, "[swear-jar] slam unsupported; plain text");
    await sendPlain(send, text);
  }
}

async function sendConfetti(send: SwearJarSend, text: string): Promise<void> {
  try {
    await send(effect(text, imessage.effect.message.confetti));
  } catch (err) {
    logger.warn({ err }, "[swear-jar] confetti unsupported; plain text");
    await sendPlain(send, text);
  }
}

function rosterFromParticipants(
  participants: GroupParticipant[] | undefined,
  senderId: string,
  senderName?: string,
): { id: string; name?: string }[] {
  const byId = new Map<string, { id: string; name?: string }>();
  for (const p of participants ?? []) {
    byId.set(p.id.toLowerCase(), { id: p.id, name: p.name });
  }
  if (!byId.has(senderId.toLowerCase())) {
    byId.set(senderId.toLowerCase(), { id: senderId, name: senderName });
  }
  return [...byId.values()];
}

function displayNameFor(
  jar: SwearJarRow,
  senderId: string,
  participants?: GroupParticipant[],
): string {
  const fromRoster = (jar.roster as { id: string; name?: string }[]).find(
    (m) => m.id.toLowerCase() === senderId.toLowerCase(),
  )?.name;
  const fromLive = participants?.find((p) => p.id.toLowerCase() === senderId.toLowerCase())?.name;
  return jarName(fromLive ?? fromRoster);
}

async function handleArm(args: {
  conversationId: string;
  senderId: string;
  space: SwearJarSpace;
  send: SwearJarSend;
  participants?: GroupParticipant[];
}): Promise<void> {
  const existing = await getActiveJar(args.conversationId);
  if (existing) {
    await sendPlain(args.send, copyAlreadyArmed());
    return;
  }

  let pot;
  try {
    pot = await getOrCreateGroupPot(args.conversationId);
  } catch (err) {
    logger.warn({ err, conversationId: args.conversationId }, "[swear-jar] pot create failed");
    await sendPlain(args.send, copyEnvOff());
    return;
  }

  const roster = rosterFromParticipants(args.participants, args.senderId);
  await armJar({
    conversationId: args.conversationId,
    potAddress: pot.address,
    roster,
  });
  await WalletAdapter.setSwearJarOptIn(args.senderId, true);

  void setAlexanderGroupAvatar({
    space: args.space,
    conversationId: args.conversationId,
  });

  const embedded = await WalletAdapter.getEmbeddedWallet(args.senderId);
  if (!embedded || !isDelegationLive(embedded.delegationExpiresAt)) {
    const url = await connectUrl(args.senderId);
    await sendPlain(args.send, copyArmNoDelegation(url));
    return;
  }
  await sendPlain(args.send, copyArm());
}

async function handleCatch(args: {
  jar: SwearJarRow;
  senderId: string;
  messageId: string;
  send: SwearJarSend;
  participants?: GroupParticipant[];
}): Promise<void> {
  await ensureOnRoster({
    jar: args.jar,
    senderId: args.senderId,
    participants: args.participants,
  });
  await touchActivity(args.jar.id, args.senderId);

  const name = displayNameFor(args.jar, args.senderId, args.participants);

  const fine = await insertFine({
    jarId: args.jar.id,
    sourceMessageId: args.messageId,
    swearerSenderId: args.senderId,
    swearerName: name,
  });
  if (!fine) return; // idempotent replay

  const burstKey = `${args.jar.id}:${args.senderId}`;
  const now = Date.now();
  const last = lastSlamAt.get(burstKey) ?? 0;
  const isBurst = now - last < BURST_COOLDOWN_MS;
  lastSlamAt.set(burstKey, now);

  const unpaid = await countPendingIous(args.jar.id, args.senderId);
  const optIn = await WalletAdapter.getSwearJarOptIn(args.senderId);

  // Always on the board. If they won't / can't pay, shame them into the pool.
  if (!optIn) {
    const url = await connectUrl(args.senderId);
    await sendSlam(args.send, copyCatchOptedOut(name, url));
    return;
  }

  if (unpaid > 3) {
    // This swear counted; stop auto-charging until they fund or nah.
    const url = await connectUrl(args.senderId);
    await sendPlain(args.send, copyIouCap(name, unpaid * SWEAR_FINE_USD, url));
    return;
  }

  const result = await collectFine({
    fine,
    potAddress: args.jar.potAddress,
    optIn: true,
  });

  if (result.ok) {
    const pot = await countPaidFines(args.jar.id);
    const line = isBurst ? copyCatchBurst(name, pot) : copyCatchFunded(name, pot);
    if (isBurst) await sendPlain(args.send, line);
    else await sendSlam(args.send, line);
    return;
  }

  if (result.reason === "opted_out") {
    const url = await connectUrl(args.senderId);
    await sendSlam(args.send, copyCatchOptedOut(name, url));
    return;
  }
  if (result.reason === "broke") {
    await sendSlam(args.send, copyCatchBroke(name));
    return;
  }
  if (result.reason === "no_wallet" || result.reason === "no_delegation") {
    const url = await connectUrl(args.senderId);
    await sendSlam(args.send, copyCatchNoWallet(name, url));
    return;
  }
  // error / busy — still shame visibly; fine stays pending on the board
  await sendSlam(args.send, copyCatchBroke(name));
}

async function handleStatus(args: {
  jar: SwearJarRow;
  send: SwearJarSend;
}): Promise<void> {
  const standings = await getStandings(args.jar);
  const pot = await countPaidFines(args.jar.id);
  await sendPlain(args.send, copyStandings(standings, pot));
}

async function handleNah(args: {
  jar: SwearJarRow;
  senderId: string;
  send: SwearJarSend;
}): Promise<void> {
  const cleared = await dismissPendingIous(args.jar.id, args.senderId);
  if (cleared > 0) {
    await sendPlain(args.send, copyDispute());
    return;
  }

  const refund = await refundLatestFine({
    jar: args.jar,
    swearerSenderId: args.senderId,
    getLatestPaid: () => getLatestPaidFineForSwearer(args.jar.id, args.senderId),
  });
  await sendPlain(args.send, refund.ok ? copyDispute() : copyNahEmpty());
}

async function handleDisarm(args: {
  conversationId: string;
  send: SwearJarSend;
}): Promise<void> {
  const jar = await getActiveJar(args.conversationId);
  if (!jar) {
    await sendPlain(args.send, "alexander isn't here.");
    return;
  }
  clearSettleConfirm(args.conversationId);
  await disarmJar(args.conversationId);
  await sendPlain(args.send, copyDisarm());
}

async function ensureOnRoster(args: {
  jar: SwearJarRow;
  senderId: string;
  participants?: GroupParticipant[];
}): Promise<void> {
  const name = args.participants?.find((p) => p.id.toLowerCase() === args.senderId.toLowerCase())
    ?.name;
  await upsertRosterMember(args.jar.id, { id: args.senderId, name });
}

async function handleOptIn(args: {
  senderId: string;
  send: SwearJarSend;
  jar?: SwearJarRow | null;
  participants?: GroupParticipant[];
}): Promise<void> {
  if (args.jar) {
    await ensureOnRoster({
      jar: args.jar,
      senderId: args.senderId,
      participants: args.participants,
    });
    await touchActivity(args.jar.id, args.senderId);
  }
  const already = await WalletAdapter.getSwearJarOptIn(args.senderId);
  const embedded = await WalletAdapter.getEmbeddedWallet(args.senderId);
  const live = isDelegationLive(embedded?.delegationExpiresAt);

  await WalletAdapter.setSwearJarOptIn(args.senderId, true);

  if (!embedded) {
    const url = await connectUrl(args.senderId);
    await sendPlain(args.send, copyOptInNeedWallet(url));
    return;
  }
  if (!live) {
    const url = await connectUrl(args.senderId);
    await sendPlain(args.send, copyOptInNeedDelegation(url));
    return;
  }
  await sendPlain(args.send, already ? copyAlreadyOptedIn() : copyOptInReady());
}

async function handleOptOut(args: {
  senderId: string;
  send: SwearJarSend;
}): Promise<void> {
  await WalletAdapter.setSwearJarOptIn(args.senderId, false);
  await sendPlain(args.send, copyOptOut());
}

async function startNextRound(args: {
  conversationId: string;
  potAddress: string;
  roster: { id: string; name?: string }[];
  participants?: GroupParticipant[];
  senderId: string;
}): Promise<void> {
  const live = rosterFromParticipants(args.participants, args.senderId);
  const merged = new Map<string, { id: string; name?: string }>();
  for (const m of args.roster) merged.set(m.id.toLowerCase(), m);
  for (const m of live) merged.set(m.id.toLowerCase(), m);
  await armJar({
    conversationId: args.conversationId,
    potAddress: args.potAddress,
    roster: [...merged.values()],
  });
}

async function handleSettle(args: {
  jar: SwearJarRow;
  send: SwearJarSend;
  senderId: string;
  participants?: GroupParticipant[];
}): Promise<void> {
  clearSettleConfirm(args.jar.conversationId);
  const claimed = await claimJarForSettle(args.jar.id);
  if (!claimed) {
    await sendPlain(args.send, "the festival already ended.");
    return;
  }

  const pot = await countPaidFines(claimed.id);
  if (pot <= 0) {
    await restoreJarActive(claimed.id, claimed.conversationId);
    await sendPlain(args.send, copyEmptySettle());
    return;
  }

  const standings = await getStandings(claimed);
  const winner = pickWinner(standings);
  const sinner = biggestSinner(standings);
  if (!winner) {
    await restoreJarActive(claimed.id, claimed.conversationId);
    await sendPlain(args.send, "nobody earned the jar this round.");
    return;
  }

  const payout = await settleToWinner({
    jar: claimed,
    winnerSenderId: winner.senderId,
    amountUsd: pot * SWEAR_FINE_USD,
  });

  if (!payout.ok && payout.reason === "no_dest") {
    await markJarSettled({
      jarId: claimed.id,
      winnerSenderId: winner.senderId,
      winnerTxHash: null,
      status: "awaiting_claim",
    });
    await startNextRound({
      conversationId: claimed.conversationId,
      potAddress: claimed.potAddress,
      roster: (claimed.roster as { id: string; name?: string }[]) ?? [],
      participants: args.participants,
      senderId: args.senderId,
    });
    const url = await connectUrl(winner.senderId);
    await sendPlain(
      args.send,
      `${jarName(winner.name)} won, but i can't reach their purse. set up here:\n${url}`,
    );
    return;
  }

  await markJarSettled({
    jarId: claimed.id,
    winnerSenderId: winner.senderId,
    winnerTxHash: payout.ok ? payout.txHash : null,
    status: "settled",
  });

  const line = copySettle({
    potUsd: pot * SWEAR_FINE_USD,
    winnerName: jarName(winner.name),
    sinnerName: sinner ? jarName(sinner.name) : null,
  });
  await startNextRound({
    conversationId: claimed.conversationId,
    potAddress: claimed.potAddress,
    roster: (claimed.roster as { id: string; name?: string }[]) ?? [],
    participants: args.participants,
    senderId: args.senderId,
  });
  await sendConfetti(args.send, line);
}

async function handleSettleConfirmAsk(args: {
  jar: SwearJarRow;
  send: SwearJarSend;
}): Promise<void> {
  const pot = await countPaidFines(args.jar.id);
  if (pot <= 0) {
    await sendPlain(args.send, copyEmptySettle());
    return;
  }
  const standings = await getStandings(args.jar);
  const winner = pickWinner(standings);
  const winnerName = jarName(winner?.name);
  pendingSettleConfirm.set(args.jar.conversationId, {
    askedAt: Date.now(),
    potUsd: pot * SWEAR_FINE_USD,
    winnerName,
  });
  await sendPlain(args.send, copySettleConfirm(pot * SWEAR_FINE_USD, winnerName));
}

async function brainContextFor(args: {
  text: string;
  mentioned: boolean;
  armed: boolean;
  jar: SwearJarRow | null;
  senderId: string;
}): Promise<BrainContext> {
  const roster = (args.jar?.roster ?? []) as { id: string; name?: string }[];
  const last = args.jar ? await getRecentFineAt(args.jar.id, args.senderId) : null;
  const pot = args.jar ? await countPaidFines(args.jar.id) : 0;
  return {
    text: args.text,
    mentioned: args.mentioned,
    armed: args.armed,
    rosterNames: roster.map((m) => jarName(m.name)).filter((n) => n && n !== "you"),
    potUsd: pot,
    lastFineAgeSec: last ? Math.round((Date.now() - last.createdAt.getTime()) / 1000) : null,
    lastFineStatus: last?.status ?? null,
  };
}

async function dispatchIntent(args: {
  intent: BrainIntent | Exclude<ReturnType<typeof resolveArmedFastPath>, "brain" | "none">;
  jar: SwearJarRow | null;
  conversationId: string;
  senderId: string;
  messageId: string;
  send: SwearJarSend;
  space: SwearJarSpace;
  participants?: GroupParticipant[];
}): Promise<boolean> {
  const { intent, jar } = args;
  if (intent === "on") {
    await handleArm({
      conversationId: args.conversationId,
      senderId: args.senderId,
      space: args.space,
      send: args.send,
      participants: args.participants,
    });
    return true;
  }
  if (intent === "off") {
    await handleDisarm({ conversationId: args.conversationId, send: args.send });
    return true;
  }
  if (intent === "help") {
    await sendPlain(args.send, copyHelp(Boolean(jar)));
    return true;
  }
  if (intent === "secrets") {
    await sendPlain(args.send, copySecrets());
    return true;
  }
  if (intent === "opt_in") {
    await handleOptIn({
      senderId: args.senderId,
      send: args.send,
      jar,
      participants: args.participants,
    });
    return true;
  }
  if (intent === "opt_out") {
    await handleOptOut({ senderId: args.senderId, send: args.send });
    return true;
  }
  if (!jar) return false;
  if (intent === "nah") {
    await handleNah({ jar, senderId: args.senderId, send: args.send });
    return true;
  }
  if (intent === "settle") {
    await handleSettle({
      jar,
      send: args.send,
      senderId: args.senderId,
      participants: args.participants,
    });
    return true;
  }
  if (intent === "settle_confirm") {
    await handleSettleConfirmAsk({ jar, send: args.send });
    return true;
  }
  if (intent === "status") {
    await touchActivity(jar.id, args.senderId);
    await handleStatus({ jar, send: args.send });
    return true;
  }
  if (intent === "swear") {
    await handleCatch({
      jar,
      senderId: args.senderId,
      messageId: args.messageId,
      send: args.send,
      participants: args.participants,
    });
    return true;
  }
  return false;
}

/**
 * Early hook for iMessage processDelivery. Returns true when this delivery
 * was fully handled (caller should markDone and return).
 */
export async function maybeHandleSwearJar(args: {
  isGroup: boolean;
  conversationId: string;
  senderId: string;
  messageId: string;
  text: string;
  space: SwearJarSpace;
  send: SwearJarSend;
  participants?: GroupParticipant[];
}): Promise<boolean> {
  if (!SWEAR_JAR_ENABLED) return false;
  if (!args.isGroup) return false;

  const raw = args.text.trim();
  if (!raw) return false;

  const mentioned = isImessageMentioned(raw);
  const stripped = mentioned ? removeImessageMention(raw) : raw;
  const cmd = normalizeCommand(stripped);
  const armed = await isJarArmed(args.conversationId);
  const common = {
    conversationId: args.conversationId,
    senderId: args.senderId,
    messageId: args.messageId,
    send: args.send,
    space: args.space,
    participants: args.participants,
  };

  // Summon / disarm / help-before-arm still need @basemate at the regex gate.
  if (mentioned) {
    if (matchOn(cmd)) {
      await handleArm(common);
      return true;
    }
    if (matchOff(cmd)) {
      await handleDisarm({ conversationId: args.conversationId, send: args.send });
      return true;
    }
    if (matchHelp(cmd)) {
      await sendPlain(args.send, copyHelp(armed));
      return true;
    }
    if (matchOptIn(cmd)) {
      await handleOptIn({
        senderId: args.senderId,
        send: args.send,
        jar: armed ? await getActiveJar(args.conversationId) : null,
        participants: args.participants,
      });
      return true;
    }
    if (matchOptOut(cmd)) {
      await handleOptOut({ senderId: args.senderId, send: args.send });
      return true;
    }
  }

  if (!armed) {
    if (
      mentioned &&
      SWEAR_JAR_BRAIN &&
      hasBrainCue(stripped, { mentioned: true })
    ) {
      const verdict = await classifyAlexander(
        await brainContextFor({
          text: stripped,
          mentioned: true,
          armed: false,
          jar: null,
          senderId: args.senderId,
        }),
      );
      if (
        verdict.intent === "on" ||
        verdict.intent === "help" ||
        verdict.intent === "opt_in" ||
        verdict.intent === "opt_out"
      ) {
        return dispatchIntent({ intent: verdict.intent, jar: null, ...common });
      }
    }
    return false;
  }

  const jar = await getActiveJar(args.conversationId);
  if (!jar) return false;

  const fast = resolveArmedFastPath(stripped);
  if (fast !== "none" && fast !== "brain") {
    if (fast !== "settle" && fast !== "settle_confirm") {
      clearSettleConfirm(args.conversationId);
    }
    return dispatchIntent({ intent: fast, jar, ...common });
  }

  if (fast === "brain" || (mentioned && SWEAR_JAR_BRAIN && hasBrainCue(stripped, { mentioned }))) {
    if (SWEAR_JAR_BRAIN) {
      const verdict = await classifyAlexander(
        await brainContextFor({
          text: stripped,
          mentioned,
          armed: true,
          jar,
          senderId: args.senderId,
        }),
      );
      if (verdict.intent !== "ignore") {
        if (verdict.intent !== "settle" && verdict.intent !== "settle_confirm") {
          clearSettleConfirm(args.conversationId);
        }
        return dispatchIntent({ intent: verdict.intent, jar, ...common });
      }
    } else if (hasSwearCue(raw) && (await judgeSwear(raw))) {
      return dispatchIntent({ intent: "swear", jar, ...common });
    }
  }

  if (settleConfirmLive(args.conversationId) && fast === "none") {
    clearSettleConfirm(args.conversationId);
  }

  await touchActivity(jar.id, args.senderId);
  return false;
}

export { SWEAR_JAR_BRAIN, SWEAR_JAR_ENABLED };
