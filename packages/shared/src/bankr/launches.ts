import type { BankrLaunchSort, BankrLaunchesResult, LaunchToken } from "../types/bankr.js";

const DISCOVER_URL = "https://api.bankr.bot/discover";
const FRESH_HOURS = 6;
const MIXED_SECTION_CAP = 4;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Momentum score for trending movers (any token age). */
export function momentumScore(t: LaunchToken): number {
  const vol1h = t.vol1h ?? 0;
  const vol24h = t.vol24h ?? 0;
  const tx = t.txCount24h ?? 0;
  const pc24 = t.priceChange24h ?? 0;
  const volWeight = Math.min(vol1h / 1000, 1);
  return vol24h * 2 + vol1h * 3 + tx * 5 * volWeight + clamp(pc24, 0, 200) * 200 * volWeight;
}

function normalizeDiscoverToken(raw: Record<string, unknown>): LaunchToken | null {
  const mcap =
    typeof raw.marketCapUsd === "number"
      ? raw.marketCapUsd
      : typeof raw.marketCap === "number"
        ? raw.marketCap
        : typeof raw.market_cap === "number"
          ? raw.market_cap
          : typeof raw.mcap === "number"
            ? raw.mcap
            : undefined;
  if (mcap === undefined || mcap <= 0) return null;

  const address = String(
    raw.address ?? raw.tokenAddress ?? raw.contractAddress ?? raw.contract ?? "",
  );
  if (!address) return null;

  const num = (k: string) => (typeof raw[k] === "number" ? (raw[k] as number) : undefined);

  return {
    name: String(raw.name ?? raw.tokenName ?? raw.token_name ?? "Unknown"),
    symbol: String(raw.symbol ?? raw.ticker ?? raw.tokenSymbol ?? "???"),
    address,
    deployer: raw.deployer ? String(raw.deployer) : undefined,
    marketCapUsd: mcap,
    createdAt: raw.createdAt ? String(raw.createdAt) : undefined,
    priceChange1h: num("priceChange1h"),
    priceChange24h: num("priceChange24h"),
    vol1h: num("vol1h"),
    vol24h: num("vol24h"),
    txCount24h: num("txCount24h"),
    deployedAt: raw.deployedAt ? String(raw.deployedAt) : undefined,
  };
}

export function sortLaunchTokens(
  tokens: LaunchToken[],
  sort: BankrLaunchSort,
  limit: number,
): BankrLaunchesResult {
  const cap = Math.max(1, limit);

  if (sort === "mcap") {
    const sorted = [...tokens]
      .sort((a, b) => (b.marketCapUsd ?? 0) - (a.marketCapUsd ?? 0))
      .slice(0, cap);
    return { sort, tokens: sorted };
  }

  if (sort === "new") {
    const sorted = [...tokens]
      .filter((t) => t.deployedAt)
      .sort(
        (a, b) =>
          new Date(b.deployedAt!).getTime() - new Date(a.deployedAt!).getTime(),
      )
      .slice(0, cap);
    return { sort, tokens: sorted };
  }

  if (sort === "trending") {
    const sorted = [...tokens].sort((a, b) => momentumScore(b) - momentumScore(a)).slice(0, cap);
    return { sort, tokens: sorted };
  }

  const freshCutoff = Date.now() - FRESH_HOURS * 60 * 60 * 1000;
  const fresh = [...tokens]
    .filter((t) => t.deployedAt && new Date(t.deployedAt).getTime() >= freshCutoff)
    .sort(
      (a, b) =>
        new Date(b.deployedAt!).getTime() - new Date(a.deployedAt!).getTime(),
    )
    .slice(0, MIXED_SECTION_CAP);

  const freshAddrs = new Set(fresh.map((t) => t.address));
  const trending = [...tokens]
    .filter((t) => !freshAddrs.has(t.address))
    .sort((a, b) => momentumScore(b) - momentumScore(a))
    .slice(0, MIXED_SECTION_CAP);

  return {
    sort: "mixed",
    tokens: [...fresh, ...trending],
    fresh,
    trending,
  };
}

async function fetchDiscoverRaw(): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(DISCOVER_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`discover ${res.status}`);
  const json = (await res.json()) as { results?: Array<Record<string, unknown>> };
  const found = json.results ?? [];
  if (found.length === 0) throw new Error("discover empty");
  return found;
}

async function fetchLegacyLaunches(): Promise<LaunchToken[]> {
  const endpoints = [
    "https://api.bankr.bot/token-launches?sort=trending&limit=50",
    "https://api.bankr.bot/token-launches?limit=50",
  ];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) continue;
      const json = (await res.json()) as {
        launches?: Array<Record<string, unknown>>;
        results?: Array<Record<string, unknown>>;
      };
      const found = json.launches ?? json.results ?? [];
      const normalized = found
        .map((t) => normalizeDiscoverToken(t))
        .filter((t): t is LaunchToken => t !== null);
      if (normalized.length > 0) return normalized;
    } catch {
      continue;
    }
  }
  return [];
}

/**
 * Fetch Bankr ecosystem tokens from `/discover` and apply sort/bucketing.
 * Used by bankr-backend and as a direct fallback when the backend is down.
 */
export async function fetchBankrLaunches(
  limit = 8,
  sort: BankrLaunchSort = "mcap",
): Promise<BankrLaunchesResult> {
  const needsDiscover = sort === "trending" || sort === "new" || sort === "mixed";

  let tokens: LaunchToken[] = [];
  try {
    const raw = await fetchDiscoverRaw();
    tokens = raw.map((t) => normalizeDiscoverToken(t)).filter((t): t is LaunchToken => t !== null);
  } catch (err) {
    if (needsDiscover) {
      console.warn("⚠️ Bankr discover unavailable for sort=%s:", sort, err);
      return { sort, tokens: [] };
    }
    tokens = await fetchLegacyLaunches();
  }

  if (tokens.length === 0) return { sort, tokens: [] };
  return sortLaunchTokens(tokens, sort, limit);
}
