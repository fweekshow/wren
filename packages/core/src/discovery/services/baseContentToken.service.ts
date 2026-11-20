export type DexScreenerPair = {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  baseToken?: {
    address?: string;
    name?: string;
    symbol?: string;
  };
  quoteToken?: {
    address?: string | null;
    name?: string | null;
    symbol?: string | null;
  };
  priceNative?: string;
  priceUsd?: string | null;
  txns?: Record<string, { buys?: number; sells?: number }>;
  volume?: Record<string, number>;
  priceChange?: Record<string, number> | null;
  liquidity?: {
    usd?: number | null;
    base?: number;
    quote?: number;
  } | null;
  fdv?: number | null;
  marketCap?: number | null;
  pairCreatedAt?: number | null;
  info?: {
    imageUrl?: string | null;
    websites?: Array<{ url?: string }>;
    socials?: Array<{ platform?: string; handle?: string }>;
  };
  boosts?: { active?: number };
};

type FetchLike = typeof fetch;

export type BaseContentTokenAnalysis = {
  address: string;
  report: string;
  tokenSymbol: string;
  tokenName?: string | null;
  imageUrl?: string | null;
};

const BASE_CONTENT_URL_RE = /https:\/\/base\.app\/content\/[^\s<>"')]+/gi;
const CONTRACT_ADDRESS_RE = /contractAddress=(0x[a-fA-F0-9]{40})/i;
const STANDALONE_CONTRACT_ADDRESS_RE = /^`?(0x[a-fA-F0-9]{40})`?$/;
const EMBEDDED_CONTRACT_ADDRESS_RE = /(0x[a-fA-F0-9]{40})/;
const TRANSACTIONAL_INTENT_RE =
  /\b(swap|send|transfer|buy|sell|pay|bridge|lend|supply|deposit|withdraw|stake|unstake|launch|approve|lp|liquidit(y|ies)|provide|transactionReference|networkId|txHash)\b/i;
const NON_TOKEN_ANALYSIS_INTENT_RE =
  /\b(avantis|perps?|positions?|open\s+trades?|pending\s+limits?|wallet)\b/i;
const TOKEN_ANALYSIS_INTENT_RE =
  /\b(analy[sz]e|analysis|rug\s*check|legit|scam|safe|honeypot|token|contract|ca|chart|dexscreener)\b/i;
const DEFAULT_HTML_SCAN_LIMIT_BYTES = 256 * 1024;
const CHUNK_TAIL_LENGTH = 96;

export function extractBaseContentUrl(text: string): string | null {
  for (const match of text.matchAll(BASE_CONTENT_URL_RE)) {
    const raw = match[0]?.replace(/[.,;!?]+$/g, "");
    if (!raw) continue;
    try {
      const url = new URL(raw);
      if (url.origin === "https://base.app" && url.pathname.startsWith("/content/")) {
        return url.toString();
      }
    } catch {
      // Ignore malformed URL-shaped text and keep scanning.
    }
  }
  return null;
}

export function extractStandaloneContractAddress(text: string): string | null {
  const match = text.trim().match(STANDALONE_CONTRACT_ADDRESS_RE);
  return match?.[1] ?? null;
}

export function extractAnalysisContractAddress(text: string): string | null {
  const standalone = extractStandaloneContractAddress(text);
  if (standalone) return standalone;
  if (TRANSACTIONAL_INTENT_RE.test(text)) return null;
  if (NON_TOKEN_ANALYSIS_INTENT_RE.test(text)) return null;
  if (!TOKEN_ANALYSIS_INTENT_RE.test(text)) return null;
  return text.match(EMBEDDED_CONTRACT_ADDRESS_RE)?.[1] ?? null;
}

export async function fetchContractAddressFromBaseContent(
  url: string,
  options: {
    fetchFn?: FetchLike;
    maxBytes?: number;
    timeoutMs?: number;
  } = {},
): Promise<string | null> {
  const parsed = new URL(url);
  if (parsed.origin !== "https://base.app" || !parsed.pathname.startsWith("/content/")) {
    return null;
  }

  const fetchFn = options.fetchFn ?? fetch;
  const maxBytes = options.maxBytes ?? DEFAULT_HTML_SCAN_LIMIT_BYTES;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const response = await fetchFn(parsed.toString(), {
    headers: { Accept: "text/html,application/xhtml+xml" },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok || !response.body) {
    return null;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let tail = "";

  try {
    while (bytesRead < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      bytesRead += value.byteLength;
      const text = decoder.decode(value, { stream: true });
      const searchable = tail + text;
      const match = searchable.match(CONTRACT_ADDRESS_RE);
      if (match?.[1]) {
        return match[1];
      }
      tail = searchable.slice(-CHUNK_TAIL_LENGTH);
    }

    const flush = decoder.decode();
    const match = (tail + flush).match(CONTRACT_ADDRESS_RE);
    return match?.[1] ?? null;
  } finally {
    reader.releaseLock();
  }
}

export async function fetchDexScreenerToken(
  address: string,
  options: {
    fetchFn?: FetchLike;
    timeoutMs?: number;
  } = {},
): Promise<DexScreenerPair | null> {
  const fetchFn = options.fetchFn ?? fetch;
  const response = await fetchFn(`https://api.dexscreener.com/tokens/v1/base/${address}`, {
    signal: AbortSignal.timeout(options.timeoutMs ?? 6_000),
  });

  if (!response.ok) return null;
  const pairs = (await response.json()) as DexScreenerPair[];
  if (!Array.isArray(pairs) || pairs.length === 0) return null;
  return selectBestDexScreenerPair(address, pairs);
}

export function selectBestDexScreenerPair(
  address: string,
  pairs: DexScreenerPair[],
): DexScreenerPair | null {
  const normalized = address.toLowerCase();
  const basePairs = pairs.filter((pair) => {
    if (pair.chainId !== "base") return false;
    const baseAddress = pair.baseToken?.address?.toLowerCase();
    const quoteAddress = pair.quoteToken?.address?.toLowerCase();
    return baseAddress === normalized || quoteAddress === normalized;
  });
  if (basePairs.length === 0) return null;

  return basePairs.sort((a, b) => liquidityUsd(b) - liquidityUsd(a))[0] ?? null;
}

export function formatBaseContentTokenReport(args: {
  address: string;
  pair: DexScreenerPair | null;
}): string {
  const { address, pair } = args;
  if (!pair) {
    return [
      "**Base token found**",
      "",
      `**Contract:** \`${address}\``,
      "",
      "DexScreener has not indexed a Base pair yet, so market data is `n/a`.",
    ].join("\n");
  }

  const token = getTokenSide(address, pair);
  const name =
    token.name && token.symbol
      ? `${token.name} ($${token.symbol})`
      : (token.symbol ?? token.name ?? "Unknown token");
  const socials = formatSocials(pair);
  const supportResistance = getSupportResistance(pair);
  const txns24h = formatTxns(pair.txns?.h24);
  const imageUrl = getDexScreenerImageUrl(pair);
  const lines = [
    ...(imageUrl ? [`![${name}](${imageUrl})`] : []),
    `**${name}**`,
    "- - -",
    `**Price:** **${formatUsdPrice(pair.priceUsd)}**` , 
    `**24h:** **${formatTrend(pair.priceChange?.h24)}** | **6h:** **${formatTrend(pair.priceChange?.h6)}** | **1h:** **${formatTrend(pair.priceChange?.h1)}** | **5m:** **${formatTrend(pair.priceChange?.h5)}**`,
    "- - -",
    `**Liquidity:** **${formatUsdCompact(pair.liquidity?.usd)}** | **Vol:** **${formatUsdCompact(pair.volume?.h24)}**`,
    `**MCap:** **${formatUsdCompact(pair.marketCap)}** | **Age:** **${formatAge(pair.pairCreatedAt)}**`,
    `**Txns:** **${txns24h}**`,
    `**Contract:** ${formatShortAddress(address)}`,
    "- - -",
    supportResistance
      ? `**Support:** **${supportResistance.support}**\n**Resistance:** **${supportResistance.resistance}**`
      : "**Support / Resistance:** **n/a**",
  
    "- - -",
    socials.length > 0
      ? `**Socials:**\n${socials.map((entry) => `- ${entry}`).join("\n")}`
      : "**Socials:** n/a",
      "- - -",
    pair.url ? `**DexScreener:**\n${pair.url}` : `**DEX:** ${pair.dexId ?? "n/a"}`,
  ];

  return lines.join("\n");
}

export function getDexScreenerImageUrl(pair: DexScreenerPair | null): string | null {
  const imageUrl = pair?.info?.imageUrl?.trim();
  if (!imageUrl) return null;

  try {
    const url = new URL(imageUrl);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function formatShortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}...${address.slice(-4)}` : address;
}

function formatTrend(value?: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  if (value > 0) return `+${value.toFixed(2)}% up`;
  if (value < 0) return `${value.toFixed(2)}% down`;
  return "0.00% flat";
}

export async function analyzeBaseContentTokenLink(
  text: string,
  options: {
    fetchFn?: FetchLike;
  } = {},
): Promise<{ handled: false } | ({ handled: true } & BaseContentTokenAnalysis)> {
  const url = extractBaseContentUrl(text);
  if (!url) return { handled: false };

  const address = await fetchContractAddressFromBaseContent(url, {
    fetchFn: options.fetchFn,
  });
  if (!address) {
    return {
      handled: true,
      address: "",
      report:
        "I found the Base content link, but the page did not expose a Base `contractAddress=` value in the scanned HTML.",
      tokenSymbol: "",
      imageUrl: null,
    };
  }

  const pair = await fetchDexScreenerToken(address, { fetchFn: options.fetchFn });
  const token = pair ? getTokenSide(address, pair) : {};
  return {
    handled: true,
    address,
    report: formatBaseContentTokenReport({ address, pair }),
    tokenSymbol: token.symbol ?? "TOKEN",
    tokenName: token.name,
    imageUrl: getDexScreenerImageUrl(pair),
  };
}

export async function analyzeBaseContractAddress(
  address: string,
  options: {
    fetchFn?: FetchLike;
  } = {},
): Promise<BaseContentTokenAnalysis> {
  const pair = await fetchDexScreenerToken(address, { fetchFn: options.fetchFn });
  const token = pair ? getTokenSide(address, pair) : {};
  return {
    address,
    report: formatBaseContentTokenReport({ address, pair }),
    tokenSymbol: token.symbol ?? "TOKEN",
    tokenName: token.name,
    imageUrl: getDexScreenerImageUrl(pair),
  };
}

function getTokenSide(
  address: string,
  pair: DexScreenerPair,
): { name?: string | null; symbol?: string | null } {
  const normalized = address.toLowerCase();
  if (pair.baseToken?.address?.toLowerCase() === normalized) return pair.baseToken;
  if (pair.quoteToken?.address?.toLowerCase() === normalized) return pair.quoteToken;
  return pair.baseToken ?? pair.quoteToken ?? {};
}

function liquidityUsd(pair: DexScreenerPair): number {
  const usd = pair.liquidity?.usd;
  return typeof usd === "number" && Number.isFinite(usd) ? usd : 0;
}

function formatAge(pairCreatedAt?: number | null): string {
  if (!pairCreatedAt) return "n/a";
  const ageMs = Date.now() - pairCreatedAt;
  if (!Number.isFinite(ageMs) || ageMs < 0) return "n/a";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function formatSocials(pair: DexScreenerPair): string[] {
  const websites = pair.info?.websites?.flatMap((site) => (site.url ? [site.url] : [])) ?? [];
  const socials =
    pair.info?.socials?.flatMap((social) => {
      if (!social.platform && !social.handle) return [];
      return [`${social.platform ?? "social"}: ${social.handle ?? "available"}`];
    }) ?? [];
  return [...websites, ...socials].slice(0, 3);
}

function getSupportResistance(
  pair: DexScreenerPair,
): { support: string; resistance: string } | null {
  const price = parseUsdPrice(pair.priceUsd);
  if (!price) return null;

  const changes = [pair.priceChange?.h1, pair.priceChange?.h6, pair.priceChange?.h24].filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
  if (changes.length === 0) return { support: `ref ${formatUsdNumber(price)}`, resistance: "n/a" };

  const maxAbsChange = Math.max(...changes.map((change) => Math.abs(change)));
  const band = Math.min(Math.max(maxAbsChange / 100, 0.03), 0.35);
  const support = price * (1 - band);
  const resistance = price * (1 + band);
  return {
    support: `~${formatUsdNumber(support)}`,
    resistance: `~${formatUsdNumber(resistance)}`,
  };
}

function parseUsdPrice(priceUsd?: string | null): number | null {
  if (!priceUsd) return null;
  const price = Number(priceUsd);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function formatUsdPrice(priceUsd?: string | null): string {
  const price = parseUsdPrice(priceUsd);
  return price ? formatUsdNumber(price) : "n/a";
}

function formatUsdNumber(value: number): string {
  if (value >= 1) return `$${value.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
  const leadingZeros = Math.max(0, Math.floor(-Math.log10(value)));
  const decimals = Math.min(leadingZeros + 4, 20);
  const formatted = value.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "");
  return `$${formatted}`;
}

function formatUsdCompact(value?: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
}

function formatTxns(txns?: { buys?: number; sells?: number }): string {
  if (!txns) return "n/a";
  const buys = txns.buys ?? 0;
  const sells = txns.sells ?? 0;
  return `${buys + sells} (${buys}B/${sells}S)`;
}
