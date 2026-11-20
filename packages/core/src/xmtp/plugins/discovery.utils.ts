/**
 * discovery.utils — pure utility functions extracted from discovery.plugin.ts.
 *
 * No Redis, no AI, no class state. All functions are deterministic string/number
 * transformers safe to unit-test in isolation.
 */

import { getAddress, isAddress } from "viem";

import type { AvantisUserTrade } from "@/discovery/ai.js";
import type { StrategyConfig } from "@basemate/shared";
import type { StrategyTradeAttribution } from "@/discovery/adapters/strategy.adapter.js";

const INLINE_ACTION_LABEL_MAX = 50;

export function extractPerpMarketSymbol(text: string): string | null {
  let t = text.trim().replace(/^(?:@\S+\s+)+/i, "").trim();
  t = t
    .replace(/\b(stock|stocks|shares?|equity|equities|tokenized)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  const longShort = t.match(/\b(?:long|short)\s+(?:on\s+)?\$?([A-Za-z0-9]{2,12})\b/i);
  if (longShort) return longShort[1].toUpperCase();

  const stockSuffix = t.match(/\b\$?([A-Za-z0-9]{2,12})\s+(?:stock|stocks)\b/i);
  if (stockSuffix) return stockSuffix[1].toUpperCase();

  const bare = t.match(/^[\$@]?([A-Za-z0-9]{2,12})$/);
  if (bare) return bare[1].toUpperCase();

  const word = t.match(/\b([A-Z]{2,10})\b/);
  if (word && !/^(LONG|SHORT|CAN|THE|AND|FOR|WITH|USD|USDC)$/i.test(word[1])) {
    return word[1].toUpperCase();
  }
  return null;
}

export function isStrategyAffirmation(message: string): boolean {
  const m = message.trim().toLowerCase().replace(/[!.?\s]+$/, "");
  return /^(that'?s it|perfect|love it|looks good|good|great|nice|ship it|done|yes|yep|that works|i'?m good|lock it in|save it)$/.test(
    m,
  );
}

export function isStrategyCancel(message: string): boolean {
  const m = message.trim().toLowerCase().replace(/[!.?\s]+$/, "");
  return /^(cancel|stop|exit|quit|nevermind|never mind|nvm|forget it|no thanks|nope|back)$/.test(m);
}

export function bumpStrategyVersion(name: string): string {
  const m = /\bv(\d+)\.(\d+)\s*$/i.exec(name);
  let next: string;
  if (m) {
    next = name.replace(/\bv\d+\.\d+\s*$/i, `v${m[1]}.${Number(m[2]) + 1}`);
  } else {
    next = `${name} v0.1`;
  }
  if (next.length <= 40) return next;
  // Trim the base so the version tag survives the 40-char cap.
  const tag = next.slice(next.lastIndexOf(" v"));
  return `${next.slice(0, 40 - tag.length).trimEnd()}${tag}`;
}

export function formatConfigChanges(oldC: StrategyConfig, newC: StrategyConfig): string[] {
  const changes: string[] = [];
  const modes = (c: StrategyConfig) => c.enabledStrategies.map((m) => m.replace(/_/g, " ")).join(", ");
  const dir = (c: StrategyConfig) => c.tradeDirection ?? "adaptive";
  if (oldC.defaultCollateralUsdc !== newC.defaultCollateralUsdc)
    changes.push(`margin: $${oldC.defaultCollateralUsdc} → $${newC.defaultCollateralUsdc}`);
  if (oldC.maxLeverage !== newC.maxLeverage)
    changes.push(`leverage: ${oldC.maxLeverage}x → ${newC.maxLeverage}x`);
  if (modes(oldC) !== modes(newC)) changes.push(`modes: ${modes(oldC)} → ${modes(newC)}`);
  if (dir(oldC) !== dir(newC)) changes.push(`direction: ${dir(oldC)} → ${dir(newC)}`);
  if (oldC.tpPercent !== newC.tpPercent) changes.push(`TP: +${oldC.tpPercent}% → +${newC.tpPercent}%`);
  if (oldC.slPercent !== newC.slPercent) changes.push(`SL: -${oldC.slPercent}% → -${newC.slPercent}%`);
  if (oldC.dailyDrawdownStopPct !== newC.dailyDrawdownStopPct)
    changes.push(`daily stop: -${oldC.dailyDrawdownStopPct}% → -${newC.dailyDrawdownStopPct}%`);
  if (oldC.riskPerTradePct !== newC.riskPerTradePct)
    changes.push(`risk/trade: ${oldC.riskPerTradePct}% → ${newC.riskPerTradePct}%`);
  return changes;
}

export function humanJoin(items: string[]): string {
  const clean = items.filter(Boolean);
  if (clean.length <= 1) return clean[0] ?? "";
  if (clean.length === 2) return `${clean[0]} and ${clean[1]}`;
  return `${clean.slice(0, -1).join(", ")} and ${clean[clean.length - 1]}`;
}

export function isSweepIntentText(message: string): boolean {
  return /\bsweep\b/i.test(message) || /\b(exit|close)\s+everything\b/i.test(message);
}

export function extractDestinationAddress(message: string): string | null {
  const match = message.match(/0x[a-fA-F0-9]{40}/)?.[0];
  return match && isAddress(match) ? getAddress(match) : null;
}

export function isConfirmText(message: string): boolean {
  return /^(confirm|yes|yep|yeah|y|ok|okay)$/i.test(message.trim());
}

export function isCancelText(message: string): boolean {
  return /^(cancel|stop|abort|no|nope|nvm|never mind)$/i.test(message.trim());
}

export function logTextHandler(opts: {
  convId: string;
  inboxId: string;
  pending: string;
  action: string;
  msg: string;
}): void {
  const safe = opts.msg.slice(0, 60).replace(/"/g, "'");
  console.log(
    `text_handler conv=${opts.convId.slice(0, 8)} user=${opts.inboxId.slice(0, 8)} ` +
      `pending=${opts.pending} action=${opts.action} msg="${safe}"`,
  );
}

export function basemateTxLink(txHash: string): string {
  return `https://app.basemate.app/txn/${txHash}`;
}

export function formatSignedUsdShort(n: number): string {
  if (!Number.isFinite(n)) return "n/a";
  const sign = n >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

export function formatStrategyListLabel(name: string, pnl: number): string {
  const pnlLabel = formatSignedUsdShort(pnl);
  const prefix = `${pnlLabel} · `;
  const maxName = INLINE_ACTION_LABEL_MAX - prefix.length;
  const shortName =
    name.length > maxName ? `${name.slice(0, Math.max(1, maxName - 1))}…` : name;
  return `${prefix}${shortName}`;
}

export function formatOpenPositionListLabel(
  trade: AvantisUserTrade,
  attribution?: StrategyTradeAttribution,
): string {
  const base = trade.pair.split("-")[0]?.replace(/USD$/i, "") ?? trade.pair;
  const side = trade.side ?? "?";
  const lev = trade.leverage ? ` ${trade.leverage}x` : "";
  const pnlUsd = Number(trade.pnlUsd);
  const pnl =
    trade.pnlUsd != null && Number.isFinite(pnlUsd)
      ? ` ${formatSignedUsdShort(pnlUsd)}`
      : "";
  const from = attribution
    ? ` · ${attribution.strategyName.length > 14 ? `${attribution.strategyName.slice(0, 13)}…` : attribution.strategyName}`
    : "";
  const full = `${base} ${side}${lev}${pnl}${from}`;
  if (full.length <= INLINE_ACTION_LABEL_MAX) return full;
  const tight = `${base} ${side}${pnl}${from}`;
  if (tight.length <= INLINE_ACTION_LABEL_MAX) return tight;
  return `${base} ${side}${pnl}`.slice(0, INLINE_ACTION_LABEL_MAX - 1) + "…";
}

export function formatOpenPositionCloseButtonLabel(trade: AvantisUserTrade): string {
  const base = trade.pair.split("-")[0]?.replace(/USD$/i, "") ?? trade.pair;
  const side = trade.side ?? "long";
  const label = `Close ${base} ${side}`;
  return label.length > INLINE_ACTION_LABEL_MAX ? `Close ${base}` : label;
}
