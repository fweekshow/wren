import { type Express } from "express";

// Simple 5-minute cache
let moonwellCache: { ts: number; apy: number; protocol: string } | null = null;
const CACHE_TTL = 5 * 60_000;

/**
 * Fetch the best USDC savings rate from Moonwell on Base.
 * Returns APY as a percentage (e.g. 4.2 = 4.2%).
 */
async function getBestUsdcYieldRate(): Promise<{ apy: number; protocol: string }> {
  const now = Date.now();
  if (moonwellCache && now - moonwellCache.ts < CACHE_TTL) {
    return { apy: moonwellCache.apy, protocol: moonwellCache.protocol };
  }

  try {
    const resp = await fetch("https://api.moonwell.fi/v1/markets?chainId=8453", {
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) throw new Error(`moonwell ${resp.status}`);
    const json = (await resp.json()) as {
      success: boolean;
      data: Array<{ asset: string; baseSupplyApy: number; totalSupplyApr: number; deprecated?: boolean }>;
    };
    if (!json.success || !Array.isArray(json.data)) throw new Error("bad payload");

    const market = json.data.find(
      (m) => !m.deprecated && ["USDC", "USDC.E"].includes(m.asset.toUpperCase()),
    );
    if (market) {
      const apy = Math.round((market.baseSupplyApy || market.totalSupplyApr) * 10) / 10;
      moonwellCache = { ts: now, apy, protocol: "Moonwell" };
      return { apy, protocol: "Moonwell" };
    }
  } catch (err) {
    console.warn("[account] yield fetch failed:", err);
  }

  // Fallback to last cached value, or a safe default
  if (moonwellCache) return { apy: moonwellCache.apy, protocol: moonwellCache.protocol };
  return { apy: 4.5, protocol: "Savings" };
}

export function mountAccountApi(app: Express) {
  // ─── Yield rate ────────────────────────────────────────────────────────────
  // Public — returns current USDC savings APY shown on the iOS Savings tab.
  app.get("/api/account/yield-rate", async (_req, res) => {
    try {
      const { apy, protocol } = await getBestUsdcYieldRate();
      res.json({ apy, protocol, asset: "USDC" });
    } catch (err) {
      res.status(500).json({ error: "Could not fetch yield rate" });
    }
  });

  // ─── Balance ───────────────────────────────────────────────────────────────
  // Requires walletAddress query param. Returns USDC balance + yield data.
  app.get("/api/account/balance", async (req, res) => {
    const walletAddress = req.query.walletAddress as string | undefined;
    if (!walletAddress) {
      return res.status(400).json({ error: "walletAddress required" });
    }

    try {
      const { getUsdcBalance } = await import("@/wallet/cdp.js");
      const { apy, protocol } = await getBestUsdcYieldRate();
      const rawBalance = await getUsdcBalance(walletAddress);
      const totalUsd = rawBalance != null ? parseFloat(rawBalance).toFixed(2) : "0.00";

      // Pending earnings: simple approximation — daily yield on current balance
      const balanceNum = parseFloat(totalUsd);
      const dailyEarnings = (balanceNum * (apy / 100)) / 365;
      const pendingEarnings = dailyEarnings.toFixed(2);

      return res.json({
        totalUsd,
        yieldApy: apy,
        yieldProtocol: protocol,
        pendingEarningsUsd: pendingEarnings,
      });
    } catch (err) {
      console.error("[account/balance]", err);
      return res.status(500).json({ error: "Could not fetch balance" });
    }
  });

  // ─── Transactions ──────────────────────────────────────────────────────────
  app.get("/api/account/transactions", async (req, res) => {
    // TODO: pull real transaction history from CDP or DB
    // For now return empty — iOS app falls back to mock data
    return res.json({ transactions: [] });
  });

  // ─── Deposit URL ───────────────────────────────────────────────────────────
  app.post("/api/account/deposit-url", async (req, res) => {
    const { walletAddress } = req.body as { walletAddress?: string };
    if (!walletAddress) {
      return res.status(400).json({ error: "walletAddress required" });
    }
    try {
      const { buildOnrampUrl } = await import("@/wallet/onramp.js");
      const url = await buildOnrampUrl({
        address: walletAddress,
        partnerUserRef: walletAddress.slice(0, 50),
      });
      const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
      return res.json({ url, expiresAt });
    } catch (err) {
      console.error("[account/deposit-url]", err);
      return res.status(500).json({ error: "Could not create deposit URL" });
    }
  });
}
