/**
 * Smoke-check portfolio API wiring locally.
 *
 * Usage (from repo root, with apps/basemate-tba/.env loaded):
 *   bun packages/core/src/portfolio/verify-local.ts <inboxId-or-imessage-senderId>
 *
 * Prints a signed URL and validates GET /api/agent/portfolio against localhost:3000.
 */
import "@/load-env.js";

import { createPortfolioAccessToken, buildSignedPortfolioUrl } from "./access.js";
import { buildPortfolioForUser } from "./service.js";

const userId = process.argv[2]?.trim();
if (!userId) {
  console.error("Usage: bun packages/core/src/portfolio/verify-local.ts <userId>");
  process.exit(1);
}

const portfolio = await buildPortfolioForUser(userId);
if (!portfolio) {
  console.error("No portfolio found for user — need a linked wallet in users / imessage_wallets.");
  process.exit(1);
}

console.log("Portfolio OK");
console.log(`  wallets: ${portfolio.user.wallets.length}`);
console.log(`  perps:   ${portfolio.perpetuals.length}`);
console.log(`  total:   $${portfolio.totals.totalUsd.toFixed(2)}`);

const url = buildSignedPortfolioUrl(userId);
console.log(`\nSigned web URL:\n${url}\n`);

const apiBase = process.env.PORTFOLIO_API_BASE?.trim() || "http://localhost:3000";
const token = createPortfolioAccessToken(userId);
const apiUrl = `${apiBase}/api/agent/portfolio?user=${encodeURIComponent(userId)}&token=${encodeURIComponent(token)}`;

try {
  const res = await fetch(apiUrl, { signal: AbortSignal.timeout(15_000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`API ${res.status}:`, body);
    process.exit(1);
  }
  console.log(`API ${res.status} OK — ${(body as { perpetuals?: unknown[] }).perpetuals?.length ?? "?"} perp rows`);
} catch (err) {
  console.warn("API fetch skipped (is basemate-tba running on :3000?):", (err as Error).message);
}
