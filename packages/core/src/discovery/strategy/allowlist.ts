import { resolveEnsNameForward } from "@/discovery/services/basename.util.js";

// Hardcoded defaults exist only as a fallback for local dev.
// In production with no env set: empty allowlist (everyone gets the normal caps).
// When STRATEGY_MULTI_ALLOWLIST is set, it fully replaces the defaults.
const DEFAULT_WALLET_ALLOWLIST = new Set([
  "0x22209cfc1397832f32160239c902b10a624cab1a",
]);

const DEFAULT_BASENAME_ALLOWLIST = ["0xteo.base.eth"];

function parseEnvAllowlist(): { wallets: Set<string>; basenames: string[] } {
  const raw = process.env.STRATEGY_MULTI_ALLOWLIST?.trim();

  if (!raw) {
    if (process.env.NODE_ENV === "production") {
      // Cap everyone at MAX_* — do not throw (that orphaned Telegram paper drafts).
      return { wallets: new Set(), basenames: [] };
    }
    return { wallets: new Set(DEFAULT_WALLET_ALLOWLIST), basenames: [...DEFAULT_BASENAME_ALLOWLIST] };
  }

  // Env is set — it fully replaces the hardcoded defaults.
  const wallets = new Set<string>();
  const basenames: string[] = [];

  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
      wallets.add(trimmed.toLowerCase());
    } else {
      basenames.push(trimmed);
    }
  }
  return { wallets, basenames };
}

function normalizeWallet(wallet?: string | null): string | undefined {
  const w = wallet?.trim().toLowerCase();
  return w && /^0x[a-f0-9]{40}$/.test(w) ? w : undefined;
}

function normalizeBasename(name?: string | null): string | undefined {
  const n = name?.trim().toLowerCase();
  return n && n.includes(".") ? n : undefined;
}

async function basenameResolvesToWallet(basename: string, wallet: string): Promise<boolean> {
  const resolved = await resolveEnsNameForward(basename).catch(() => null);
  return resolved?.toLowerCase() === wallet;
}

/**
 * Internal testers who may run multiple concurrent testing/published strategies.
 */
export async function isMultiStrategyAllowed(args: {
  wallet?: string | null;
  basename?: string | null;
}): Promise<boolean> {
  const { wallets, basenames } = parseEnvAllowlist();
  const wallet = normalizeWallet(args.wallet);
  const basename = normalizeBasename(args.basename);

  if (wallet && wallets.has(wallet)) return true;
  if (basename && basenames.some((b) => b.toLowerCase() === basename)) return true;

  if (wallet) {
    for (const name of basenames) {
      if (await basenameResolvesToWallet(name, wallet)) return true;
    }
  }

  if (basename) {
    for (const name of basenames) {
      if (name.toLowerCase() === basename) return true;
      const [allowedResolved, userResolved] = await Promise.all([
        resolveEnsNameForward(name).catch(() => null),
        resolveEnsNameForward(basename).catch(() => null),
      ]);
      if (
        allowedResolved &&
        userResolved &&
        allowedResolved.toLowerCase() === userResolved.toLowerCase()
      ) {
        return true;
      }
    }
  }

  return false;
}
