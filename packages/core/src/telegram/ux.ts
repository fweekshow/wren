import { shortAddress } from "@/discovery/strategy/wallet.js";
import { buildTpslMarginDisplay, formatTpslOnMarginShort } from "@/discovery/strategy/tpsl.js";

/**
 * Pure Telegram VibeTrading view models: message text + inline-keyboard layout.
 *
 * Telegram paints button chrome (we can't set color/opacity). Design lever is
 * hierarchy in the message body (HTML) + short, scannable button labels.
 *
 * Buttons describe an intended action (not wire `callback_data`). The webhook
 * layer mints opaque `cb_<uuid>` per button (see `callbackStore.ts`).
 */

export interface TgAction {
  action: string;
  strategyId?: string | null;
  version?: number | null;
  params?: Record<string, string>;
}

export interface TgButton {
  text: string;
  /** Server-side action (opaque callback minted by the transport). */
  action?: TgAction;
  /** External link (e.g. wallet top-up), rendered as a url button. */
  url?: string;
}

export interface TgView {
  /** HTML body (parse_mode=HTML). Escape user-controlled strings with `esc`. */
  text: string;
  keyboard: TgButton[][];
}

export type StrategyMode = "paper" | "live";
export type PnlState = "paper" | "live_open" | "live_closed_pending" | "live_closed_final";

export interface StrategyModeLine {
  label: string;
  blurb: string;
  live: boolean;
}

export interface StrategyCardVM {
  strategyId: string;
  name: string;
  mode: StrategyMode;
  version?: number | null;
  pairs: string[];
  direction: "long" | "short" | "adaptive";
  marginUsdc: number;
  leverage: number;
  tpPercent: number;
  slPercent: number;
  /** Effective SL after liquidation-buffer cap (what the runner uses). */
  effectiveSlPercent?: number;
  slCapped?: boolean;
  walletAddress?: string | null;
  pnlUsd: number;
  pnlState: PnlState;
  /** Active Tactical Alpha modes (the actual playbook this strategy runs). */
  modes: StrategyModeLine[];
  /** Regime guards. */
  antiChop: boolean;
  alphaCrush: boolean;
  /** Paper default-size bump indicator. */
  demoSize?: boolean;
}

export interface StrategyListItemVM {
  strategyId: string;
  name: string;
  mode: StrategyMode;
  version?: number | null;
  pnlUsd: number;
  pnlState: PnlState;
}

/** Escape user-controlled text for Telegram HTML parse_mode. */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Telegram HTML has no list tags — render bullets as "• " prefixed lines.
 * Inline the pre-formatted lines (they may already contain <b>/<code>); callers
 * `esc` any user-controlled fragment themselves.
 */
function bullets(items: string[]): string {
  return items.map((i) => `• ${i}`).join("\n");
}

/** Margin-first TP/SL line from card/technicals VM fields (execution still uses price move). */
function tpslOnMarginLine(args: {
  tpPercent: number;
  slPercent: number;
  effectiveSlPercent?: number;
  slCapped?: boolean;
  leverage: number;
}): string {
  const slPrice = args.effectiveSlPercent ?? args.slPercent;
  return formatTpslOnMarginShort(
    buildTpslMarginDisplay({
      tpPricePct: args.tpPercent,
      slPricePct: slPrice,
      leverage: args.leverage,
      slCapped: args.slCapped,
    }),
  );
}

const money = (v: number): string => `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`;

/**
 * PnL label system — never conflates modeled paper PnL with settled live PnL.
 *  paper                → "modeled PnL (est.)"
 *  live_open            → "unrealized (mark)"
 *  live_closed_pending  → "closed · settling on-chain"
 *  live_closed_final    → "settled PnL"
 */
export function pnlLabel(state: PnlState, valueUsd: number, opts: { demoSize?: boolean } = {}): string {
  const demo = opts.demoSize ? " (demo size)" : "";
  switch (state) {
    case "paper":
      return `modeled PnL (est.) ${money(valueUsd)}${demo}`;
    case "live_open":
      return `unrealized (mark) ${money(valueUsd)}`;
    case "live_closed_pending":
      return `${money(valueUsd)} · settling on-chain (provisional)`;
    case "live_closed_final":
      return `settled PnL ${money(valueUsd)}`;
  }
}

const FEE_ONE_LINER = "Basemate takes 10% of new profits above your high-water mark.";
const TPSL_DISCLAIMER = "TP/SL are targets — fast moves can fill worse.";

/** Home screen for a user with no linked Base App account. */
export function homeUnlinkedView(): TgView {
  return {
    text: "<b>Basemate</b>\n\nPaper trading and automated strategies are off.",
    keyboard: [],
  };
}

/** Home screen for a linked / Telegram-native user. */
export function homeLinkedView(_opts: { killSwitchOn?: boolean } = {}): TgView {
  return {
    text: "<b>Basemate</b>\n\nPaper trading and automated strategies are off.",
    keyboard: [[{ text: "Wallet", action: { action: "wallet" } }]],
  };
}

/** Compact list button: mode badge + name + PnL (Telegram max ~64 chars). */
function strategyListButton(s: StrategyListItemVM): TgButton {
  const badge = s.mode === "live" ? "LIVE" : "paper";
  const label = `${badge} · ${truncate(s.name, 18)} · ${money(s.pnlUsd)}`;
  return {
    text: truncate(label, 64),
    action: { action: "open_detail", strategyId: s.strategyId, version: s.version },
  };
}

/** My Strategies — scannable HTML body + short tappable rows. */
export function myStrategiesView(items: StrategyListItemVM[]): TgView {
  if (items.length === 0) {
    return {
      text: "<b>My strategies</b>\n\nNone yet — tap New Strategy and describe what you want.",
      keyboard: [
        [{ text: "New Strategy", action: { action: "new_strategy" } }],
        [{ text: "‹ Home", action: { action: "home" } }],
      ],
    };
  }

  const ordered = [...items].sort((a, b) => (a.mode === b.mode ? 0 : a.mode === "live" ? -1 : 1));
  const live = ordered.filter((s) => s.mode === "live");
  const paper = ordered.filter((s) => s.mode === "paper");

  const lines: string[] = ["<b>My strategies</b>", ""];
  if (live.length) {
    lines.push("<b>Live</b>");
    for (const s of live) {
      lines.push(`• ${esc(truncate(s.name, 28))} · <code>${money(s.pnlUsd)}</code>`);
    }
    lines.push("");
  }
  if (paper.length) {
    lines.push("<b>Paper</b>");
    for (const s of paper) {
      lines.push(`• ${esc(truncate(s.name, 28))} · <code>${money(s.pnlUsd)}</code>`);
    }
    lines.push("");
  }
  lines.push("Tap a row to open →");

  const keyboard: TgButton[][] = ordered.map((s) => [strategyListButton(s)]);
  keyboard.push([{ text: "New Strategy", action: { action: "new_strategy" } }]);
  keyboard.push([{ text: "‹ Home", action: { action: "home" } }]);
  return { text: lines.join("\n"), keyboard };
}

/** Format the active Tactical Alpha playbook for a card. */
function playbookLines(vm: StrategyCardVM): string[] {
  if (!vm.modes.length) return [];
  const out = ["<b>Playbook</b>"];
  for (const m of vm.modes) {
    out.push(`• <b>${esc(m.label)}</b> — ${esc(m.blurb)}${m.live ? "" : " (coming soon)"}`);
  }
  const guards: string[] = [];
  if (vm.antiChop) guards.push("skips true chop");
  if (vm.alphaCrush) guards.push("alpha-crush on");
  if (guards.length) out.push(`<b>Guards:</b> ${esc(guards.join(" · "))}`);
  return out;
}

/** Strategy detail card. */
export function strategyCardView(vm: StrategyCardVM, opts: { livePaused?: boolean } = {}): TgView {
  const mode = vm.mode === "live" ? "LIVE" : "PAPER";
  const lines = [
    `<b>${esc(vm.name)}</b> · ${mode}`,
    "",
    bullets([
      `${esc(vm.pairs.join(", "))} · ${esc(vm.direction)}`,
      `$${vm.marginUsdc} margin · ${vm.leverage}x`,
      tpslOnMarginLine(vm),
    ]),
    "",
    ...playbookLines(vm),
    vm.walletAddress ? `Wallet · <code>${esc(shortAddress(vm.walletAddress))}</code>` : null,
    "",
    esc(pnlLabel(vm.pnlState, vm.pnlUsd, { demoSize: vm.demoSize })),
  ].filter((l): l is string => l != null);

  const sid = vm.strategyId;
  const ver = vm.version;
  const actions: TgButton[][] = [];
  if (vm.mode === "paper" && !opts.livePaused) {
    actions.push([
      { text: "Go Live", action: { action: "go_live_confirm", strategyId: sid, version: ver } },
    ]);
  }
  actions.push([
    { text: "Modify", action: { action: "modify", strategyId: sid, version: ver } },
    { text: "Remix", action: { action: "remix", strategyId: sid, version: ver } },
  ]);
  actions.push([
    { text: "Stop", action: { action: "stop", strategyId: sid, version: ver } },
    { text: "Technicals", action: { action: "technicals", strategyId: sid, version: ver } },
  ]);
  actions.push([
    { text: "‹ My Strategies", action: { action: "my_strategies" } },
    { text: "Home", action: { action: "home" } },
  ]);
  return { text: lines.join("\n"), keyboard: actions };
}

/** Remix proposal preview — shows the AI's diagnosis + proposed config, Apply/Keep. */
export function remixPreviewView(vm: StrategyCardVM, diagnosis: string): TgView {
  const card = strategyCardView(vm);
  return {
    text: `<b>Proposed tweak</b>\n${esc(diagnosis)}\n\n${card.text}`,
    keyboard: [
      [{ text: "Apply", action: { action: "remix_apply", strategyId: vm.strategyId, version: vm.version } }],
      [{ text: "Keep current", action: { action: "open_detail", strategyId: vm.strategyId, version: vm.version } }],
    ],
  };
}

/** Modify proposal preview — hints-only patch, Apply/Keep. */
export function modifyPreviewView(vm: StrategyCardVM, summary: string): TgView {
  const card = strategyCardView(vm);
  return {
    text: `<b>Proposed modify</b>\n${esc(summary)}\n\n${card.text}`,
    keyboard: [
      [{ text: "Apply", action: { action: "modify_apply", strategyId: vm.strategyId, version: vm.version } }],
      [{ text: "Keep current", action: { action: "open_detail", strategyId: vm.strategyId, version: vm.version } }],
    ],
  };
}

export interface StrategyTechnicalsVM {
  name: string;
  status: string;
  lastEvalAgeSec: number | null;
  tradeCount: number;
  pairLines: string[];
  configSpec: string;
  direction: string;
  antiChop: boolean;
  marginUsdc: number;
  leverage: number;
  tpPercent: number;
  slPercent: number;
  effectiveSlPercent: number;
  slCapped: boolean;
  riskPerTradePct: number;
  dailyDrawdownStopPct: number;
  lossStreakCooldown: boolean;
  strategyId: string;
  version?: number | null;
}

/** Runtime oracle + config truth screen. */
export function strategyTechnicalsView(vm: StrategyTechnicalsVM): TgView {
  const evalAge =
    vm.lastEvalAgeSec != null ? `${vm.lastEvalAgeSec}s ago` : "never";
  const tpsl = tpslOnMarginLine(vm);
  const lines = [
    `<b>Technicals</b> · ${esc(vm.name)}`,
    `Status · ${esc(vm.status)} · last eval ${evalAge} · trades ${vm.tradeCount}`,
    "",
    `<b>Oracle</b> · 1m marks × 12 bars (~12 min)`,
    ...vm.pairLines.map((l) => esc(l)),
    "",
    `<b>Config</b>`,
    esc(vm.configSpec),
    `Direction · ${esc(vm.direction)} · antiChop · ${vm.antiChop ? "on" : "off"}`,
    `Margin · $${vm.marginUsdc} · ${vm.leverage}x`,
    tpsl,
    `Risk · ${vm.riskPerTradePct}%/trade · daily stop -${vm.dailyDrawdownStopPct}% · loss streak ${vm.lossStreakCooldown ? "on" : "off"}`,
  ];
  return {
    text: lines.join("\n"),
    keyboard: [
      [{ text: "‹ Back to strategy", action: { action: "open_detail", strategyId: vm.strategyId, version: vm.version } }],
    ],
  };
}

/** Mandatory Go Live confirmation — real-money disclosure before any live open. */
export function goLiveConfirmView(vm: StrategyCardVM): TgView {
  const text = [
    `<b>Go Live</b> · ${esc(vm.name)}`,
    "",
    bullets([
      `${esc(vm.pairs.join(", "))} · $${vm.marginUsdc} · ${vm.leverage}x`,
      tpslOnMarginLine(vm),
      ...(vm.walletAddress ? [`Wallet · <code>${esc(shortAddress(vm.walletAddress))}</code>`] : []),
    ]),
    "",
    "<b>Before you confirm</b>",
    bullets(["This uses real USDC from your Basemate strategy wallet.", FEE_ONE_LINER, TPSL_DISCLAIMER]),
  ].join("\n");
  return {
    text,
    keyboard: [
      [{ text: "Confirm Go Live", action: { action: "go_live", strategyId: vm.strategyId, version: vm.version } }],
      [{ text: "Cancel", action: { action: "open_detail", strategyId: vm.strategyId, version: vm.version } }],
    ],
  };
}

/** After a successful account link. */
export function linkedSuccessView(walletAddress?: string | null): TgView {
  const wallet = walletAddress
    ? `\n\nYour Basemate wallet · <code>${esc(shortAddress(walletAddress))}</code>`
    : "";
  return {
    text: `<b>Linked</b>\nYou can run your Base App strategies from Telegram.${wallet}`,
    keyboard: [
      [{ text: "My Strategies", action: { action: "my_strategies" } }],
      [{ text: "New Strategy", action: { action: "new_strategy" } }],
    ],
  };
}

/** Copy for callback failures — always paired with answerCallbackQuery. */
export const CALLBACK_FAILURE_COPY: Record<string, string> = {
  not_found: "This menu expired — open My Strategies.",
  expired: "This menu expired — open My Strategies.",
  wrong_user: "That button isn't for you.",
  wrong_chat: "That button isn't for this chat.",
  already_used: "Already handled — open My Strategies for the latest.",
  stale_version: "This strategy changed — refreshing.",
  group_only: "That button isn't for this chat.",
};

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

export interface WalletBalanceLine {
  symbol: string;
  formatted: string;
}

/** Strategy execution wallet — balances, automated-trading disclosure, funding actions. */
export function walletView(args: {
  walletAddress: string;
  balances: WalletBalanceLine[];
  fundUrl?: string | null;
}): TgView {
  const usdc = args.balances.find((b) => b.symbol === "USDC");
  const usdcLine = usdc ? `$${Number(usdc.formatted).toFixed(2)}` : "$0.00";

  const lines = [
    "<b>Basemate strategy wallet</b>",
    "",
    bullets([
      "Runs your <b>Live</b> strategies <b>fully automatically</b> — I open and close trades for you. Paper strategies don't touch it.",
      "A dedicated strategy wallet — not your Base App or iMessage wallet.",
    ]),
    "",
    "<b>Balance</b>",
    `USDC · <code>${usdcLine}</code>`,
    "<i>USDC only — gas is covered by Basemate</i>",
    "",
    `<code>${esc(args.walletAddress)}</code>`,
    "",
    args.fundUrl
      ? "Tap Add Funds for Apple Pay on basemate.app, or send USDC on Base to this address."
      : "Send USDC on Base to this address to fund live strategies.",
  ];

  const keyboard: TgButton[][] = [];
  if (args.fundUrl) {
    keyboard.push([{ text: "Add Funds", url: args.fundUrl }]);
  }
  keyboard.push([{ text: "‹ Home", action: { action: "home" } }]);

  return { text: lines.join("\n"), keyboard };
}
