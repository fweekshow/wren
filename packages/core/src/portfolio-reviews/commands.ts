import {
  PortfolioReviewAdapter,
  type PortfolioReviewPlatform,
} from "@/discovery/adapters/portfolioReview.adapter.js";
import { resolveEnsNameForward } from "@/discovery/services/basename.util.js";

import { formatReviewSchedule, nextDailyRunAt, parseReviewTime, isValidTimezone } from "./time.js";

const ETH_ADDRESS_RE = /0x[a-fA-F0-9]{40}/;
const NAME_RE = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:base\.)?eth\b/i;
const PORTFOLIO_REVIEW_RE =
  /\b((?:portfolio|portolfio)\s+review|daily\s+review|(?:portfolio|portolfio)\s+digest)\b/i;
const DISABLE_RE = /\b(turn\s+off|disable|stop|cancel|pause)\b/i;
const SHOW_RE = /\b(show|view|status|settings?|when)\b/i;
const SET_RE = /\b(set|send|start|enable|change|update|every\s+day|daily)\b/i;
const PENDING_TTL_MS = 10 * 60 * 1000;

interface PendingTimezone {
  platform: PortfolioReviewPlatform;
  userKey: string;
  walletAddress: string;
  dmTarget: Record<string, unknown> | null;
  localTime: string;
  createdAt: number;
}

export interface PortfolioReviewCommandInput {
  platform: PortfolioReviewPlatform;
  userKey: string;
  text: string;
  walletAddress?: string | null;
  dmTarget: Record<string, unknown> | null;
  defaultTimezone?: string | null;
}

export type PortfolioReviewCommandResult =
  | { handled: false }
  | { handled: true; reply: string };

const pendingTimezone = new Map<string, PendingTimezone>();

function commandKey(platform: PortfolioReviewPlatform, userKey: string): string {
  return `${platform}:${userKey}`;
}

function cleanupPending(): void {
  const now = Date.now();
  for (const [key, value] of pendingTimezone) {
    if (now - value.createdAt > PENDING_TTL_MS) pendingTimezone.delete(key);
  }
}

async function resolveWalletFromText(text: string): Promise<string | null> {
  const address = text.match(ETH_ADDRESS_RE)?.[0];
  if (address) return address.toLowerCase();
  const name = text.match(NAME_RE)?.[0];
  if (!name) return null;
  return resolveEnsNameForward(name);
}

export function isPortfolioReviewIntent(text: string): boolean {
  return PORTFOLIO_REVIEW_RE.test(text);
}

async function enableReview(args: {
  platform: PortfolioReviewPlatform;
  userKey: string;
  walletAddress: string;
  dmTarget: Record<string, unknown> | null;
  localTime: string;
  timezone: string;
}): Promise<string> {
  const nextRunAt = nextDailyRunAt(args.localTime, args.timezone);
  await PortfolioReviewAdapter.upsertSubscription({
    platform: args.platform,
    userKey: args.userKey,
    walletAddress: args.walletAddress,
    dmTarget: args.dmTarget,
    localTime: args.localTime,
    timezone: args.timezone,
    nextRunAt,
  });
  return `Done — I'll send your portfolio review every day at ${formatReviewSchedule(
    args.localTime,
    args.timezone,
  )}.`;
}

export async function handlePortfolioReviewCommand(
  input: PortfolioReviewCommandInput,
): Promise<PortfolioReviewCommandResult> {
  cleanupPending();
  const text = input.text.trim();
  const key = commandKey(input.platform, input.userKey);
  const pending = pendingTimezone.get(key);

  if (pending && isValidTimezone(text)) {
    pendingTimezone.delete(key);
    return {
      handled: true,
      reply: await enableReview({
        ...pending,
        timezone: text,
      }),
    };
  }

  if (!isPortfolioReviewIntent(text)) return { handled: false };

  if (DISABLE_RE.test(text)) {
    const disabled = await PortfolioReviewAdapter.disableSubscription(
      input.platform,
      input.userKey,
    );
    return {
      handled: true,
      reply: disabled
        ? "Done — daily portfolio reviews are turned off."
        : "You don't have an active daily portfolio review yet.",
    };
  }

  if (SHOW_RE.test(text) && !SET_RE.test(text)) {
    const sub = await PortfolioReviewAdapter.getSubscription(input.platform, input.userKey);
    if (!sub || !sub.enabled) {
      return {
        handled: true,
        reply: "You don't have an active daily portfolio review yet. Say something like: portfolio review every day at 8am America/New_York.",
      };
    }
    return {
      handled: true,
      reply: `Your daily portfolio review is set for ${formatReviewSchedule(
        sub.local_time,
        sub.timezone,
      )}.`,
    };
  }

  const parsed = parseReviewTime(text);
  if (!parsed) {
    return {
      handled: true,
      reply: "What time should I send it? Example: portfolio review every day at 8am America/New_York.",
    };
  }

  const walletFromText = await resolveWalletFromText(text);
  const walletAddress = walletFromText ?? input.walletAddress ?? null;
  if (!walletAddress) {
    return {
      handled: true,
      reply: "I need the wallet to review. Send it with the schedule, like: portfolio review every day at 8am America/New_York for 0x1234...",
    };
  }

  const timezone = parsed.timezone ?? input.defaultTimezone ?? null;
  if (!timezone || !isValidTimezone(timezone)) {
    pendingTimezone.set(key, {
      platform: input.platform,
      userKey: input.userKey,
      walletAddress,
      dmTarget: input.dmTarget,
      localTime: parsed.localTime,
      createdAt: Date.now(),
    });
    return {
      handled: true,
      reply: "What timezone should I use? Reply with an IANA timezone like America/New_York, Europe/London, or Asia/Kolkata.",
    };
  }

  return {
    handled: true,
    reply: await enableReview({
      platform: input.platform,
      userKey: input.userKey,
      walletAddress,
      dmTarget: input.dmTarget,
      localTime: parsed.localTime,
      timezone,
    }),
  };
}
