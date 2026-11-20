import { createHash } from "node:crypto";

/** Opt-in master switch. Unset / false / 0 = dead path (opposite of World Cup). */
export const SWEAR_JAR_ENABLED = process.env.SWEAR_JAR_ENABLED === "true";

/**
 * Hybrid JSON brain. Default on whenever the jar itself is enabled.
 * Set SWEAR_JAR_BRAIN=false to fall back to regex + the cheap swear judge.
 */
function envTriState(name: string): boolean | undefined {
  const v = process.env[name]?.trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return undefined;
}

export const SWEAR_JAR_BRAIN = envTriState("SWEAR_JAR_BRAIN") ?? SWEAR_JAR_ENABLED;

export const SWEAR_JAR_BRAIN_MODEL = process.env.SWEAR_JAR_BRAIN_MODEL?.trim() || undefined;

export const SETTLE_CONFIRM_MS = 2 * 60_000;

export const ALEXANDER_IMAGE_URL =
  "https://res.cloudinary.com/ixvgxhls/image/upload/v1788503460/images-2.jpg";

export const SWEAR_FINE_USD = 1;
export const BURST_COOLDOWN_MS = 8_000;
export const BASE_CHAIN_ID = "0x2105" as const;

/**
 * CDP owner account name for this group's pot.
 * Names: [a-zA-Z0-9-], 2–36 chars. Deterministic per conversation — no shared pot.
 */
export function potAccountNameForConversation(conversationId: string): string {
  const hash = createHash("sha256").update(conversationId).digest("hex").slice(0, 28);
  return `sj-${hash}`;
}

/** Smart-account name owned by the pot EOA (paymaster-sponsored sends). */
export function potSmartAccountName(ownerAccountName: string): string {
  const body = ownerAccountName.startsWith("sj-")
    ? ownerAccountName.slice(3)
    : ownerAccountName.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 33);
  return `sa-${body}`.slice(0, 36);
}

/** Locked 60s film script (operator: film, then X + Typeform). */
export const DEMO_FILM_SCRIPT = [
  "Mom: @basemate alexander on → group PFP becomes Alexander, then intro bubble.",
  "Dad: this is bullshit → slam + a fine curse, dad. $1 into the jar. i'm at $1.",
  "Mom: oh hell no → a fine curse, mom. $1 into the jar. i'm at $2.",
  "Dad: what the fuck → again, dad. another $1. i'm at $3.",
  "Mom: how's alexander → emma guards her tongue, dad fills him",
  "Mom: alexander settle → confetti: emma cleanest mouth, dad filled the jar",
  "Tweet: I summoned Iron Fist Alexander into our family iMessage. Dad filled the jar.",
  "Submit: https://photonhq.typeform.com/to/yqt76Mv9",
] as const;
