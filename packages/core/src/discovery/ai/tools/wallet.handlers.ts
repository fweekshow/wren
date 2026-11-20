/**
 * wallet.handlers — custodial wallet tools plus send_token / send_token_bundle.
 *
 * Extracted from toolbox.ts (private helpers + methods at lines ~1010-1037,
 * 1103-1178, 1180-1822, 3724-3732).
 *
 * Exported surface (Toolbox delegates via one-liners):
 *   custodialWalletOrError  — guards custodial-only tools
 *   get_wallet_balance      — wallet balance (custodial + XMTP portfolio path)
 *   fund_wallet             — onramp link (custodial only)
 *   sweep_funds             — preview sweep to linked wallet (any platform)
 *   withdraw_funds          — custodial wallet withdrawal
 *   offramp_to_fiat         — Coinbase offramp link (custodial only)
 *   send_token              — ERC-20 / ETH transfer (wallet_sendCalls)
 *   send_token_bundle       — multi-asset transfer in one wallet_sendCalls
 *   resolve_name            — Basename / ENS forward + reverse lookup
 */

import {
  encodeFunctionData,
  formatUnits,
  getAddress,
  isAddress,
  parseUnits,
  toHex,
  type Address,
} from "viem";

import { resolveSendAmount, sanitizeAmount } from "@basemate/shared";
import { shortWalletLabel } from "@/account-linking/index.js";
import { config } from "@/config/config.js";
import { fetchBasePortfolioHoldings, type PortfolioHolding } from "@/portfolio-reviews/balances.js";
import { buildSignedPortfolioUrl, tryBuildSignedPortfolioUrl } from "@/portfolio/access.js";
import { formatCoinsSummaryForImessage } from "@/portfolio/summary.js";
import {
  BASE_USDC_ADDRESS,
  getBalances,
  getUsdcBalance,
  isCdpEnabled,
  withdraw as cdpWithdraw,
} from "@/wallet/cdp.js";
import {
  formatSweepPreview,
  resolveCustodialSweepWallets,
} from "@/wallet/sweep.js";
import { buildOfframpUrl, buildOnrampUrl } from "@/wallet/onramp.js";
import { WalletAdapter } from "@/discovery/adapters/wallet.adapter.js";
import { UserAdapter } from "@/discovery/adapters/user.adapter.js";
const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
import {
  assertSwapUsdWithinLimit,
  resolveUsdQuotedSwapAmount,
  usdToTokenAmount,
} from "@/discovery/ai/amounts.js";
import { isStablecoinAddress, resolveTokenAsync } from "@/discovery/ai/tokens.js";
import { ERC20_ABI } from "@/discovery/ai/tools/swap.js";
import {
  resolveBasename,
  resolveEnsNameForward,
} from "@/discovery/services/basename.util.js";
function formatUsd(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}
import { buildChannelPortfolio, portfolioUserKey } from "@/discovery/ai/tools/portfolio.handlers.js";
import type { RespondCtx, ToolResult } from "@/discovery/ai/toolbox.js";
import { trimAmount, shortenAddress } from "@/discovery/ai/toolbox.js";
import type { WalletCall } from "@/discovery/ai/types.js";
import { FundSessionAdapter } from "@/wallet/fundSession.js";

const ALL_AMOUNT_RE = /^(all|everything|max|maximum)$/i;
/** Leave a tiny ETH buffer so the user can still pay gas after "send all ETH". */
const ETH_ALL_GAS_RESERVE = "0.00005";

async function readWalletTokenBalance(
  walletAddress: string,
  token: { address: string; decimals: number; symbol: string },
): Promise<{ amount: string } | { error: string }> {
  try {
    const { createPublicClient, http } = await import("viem");
    const { base } = await import("viem/chains");
    const { resolveBaseRpcUrl } = await import("@/chain/base-rpc.js");
    const client = createPublicClient({
      chain: base,
      transport: http(resolveBaseRpcUrl()),
    });

    if (token.address === "ETH") {
      const wei = await client.getBalance({ address: walletAddress as Address });
      const reserve = parseUnits(ETH_ALL_GAS_RESERVE, 18);
      const spendable = wei > reserve ? wei - reserve : 0n;
      if (spendable <= 0n) {
        return { error: `you don't have enough ETH to send after leaving a tiny gas reserve` };
      }
      return { amount: formatUnits(spendable, 18) };
    }

    const raw = await client.readContract({
      address: token.address as Address,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [walletAddress as Address],
    });
    if (raw <= 0n) {
      return { error: `you don't have any ${token.symbol} to send` };
    }
    return { amount: formatUnits(raw, token.decimals) };
  } catch (err) {
    console.error("readWalletTokenBalance failed:", (err as Error)?.message || err);
    return { error: `couldn't read your ${token.symbol} balance — try again in a sec` };
  }
}

// ── Private helpers ───────────────────────────────────────────────────────────

export function custodialWalletOrError(ctx: RespondCtx):
  | { ok: true; address: string; accountName: string | undefined }
  | { ok: false; result: ToolResult } {
  if (!ctx.custodialWallet || !isCdpEnabled()) {
    return {
      ok: false,
      result: {
        data: { error: "custodial wallet unavailable" },
        control: { type: "text", text: "wallets aren't available here yet — hang tight" },
      },
    };
  }
  const address = ctx.walletAddress;
  if (!address) {
    return {
      ok: false,
      result: {
        data: { error: "wallet not provisioned" },
        control: {
          type: "text",
          text: "i couldn't load your wallet just now — try again in a sec",
        },
      },
    };
  }
  return { ok: true, address, accountName: ctx.custodialAccountName };
}

function selfWalletSet(ctx: RespondCtx): string[] {
  const set = new Set<string>();
  const add = (addr?: string | null) => {
    if (addr && ETH_ADDRESS_RE.test(addr)) set.add(addr.toLowerCase());
  };
  add(ctx.walletAddress);
  for (const wallet of ctx.linkedWallets ?? []) add(wallet);
  return [...set];
}

async function aggregatedWalletBalance(
  ctx: RespondCtx,
  wallets: string[],
  custodialAddress: string,
): Promise<ToolResult> {
  const custodial = custodialAddress.toLowerCase();
  const MIN_USD = 0.01;
  const perWallet: {
    wallet: string;
    holdings: PortfolioHolding[] | null;
    totalUsd: number;
  }[] = [];

  for (const wallet of wallets) {
    try {
      const holdings = (await fetchBasePortfolioHoldings(wallet)).filter(
        (h) => h.valueUsd >= MIN_USD,
      );
      const totalUsd = holdings.reduce((sum, h) => sum + h.valueUsd, 0);
      perWallet.push({ wallet, holdings, totalUsd });
    } catch (err: any) {
      console.error("aggregated balance failed for", wallet, err?.message || err);
      perWallet.push({ wallet, holdings: null, totalUsd: 0 });
    }
  }

  const aggregate = new Map<string, { symbol: string; amount: number; valueUsd: number }>();
  for (const { holdings } of perWallet) {
    if (!holdings) continue;
    for (const h of holdings) {
      const key = (h.tokenAddress ?? h.symbol).toLowerCase();
      const entry = aggregate.get(key) ?? { symbol: h.symbol, amount: 0, valueUsd: 0 };
      entry.amount += Number(h.amount) || 0;
      entry.valueUsd += h.valueUsd;
      aggregate.set(key, entry);
    }
  }
  const combinedTotalUsd = perWallet.reduce((sum, p) => sum + p.totalUsd, 0);

  const lines: string[] = ["here are your connected wallets 👇"];
  for (const { wallet, holdings, totalUsd } of perWallet) {
    const label =
      wallet.toLowerCase() === custodial
        ? `Server wallet (${shortWalletLabel(wallet)})`
        : `Base App wallet (${shortWalletLabel(wallet)})`;
    if (!holdings) {
      lines.push("", label);
      lines.push("• couldn't load this one right now");
      continue;
    }
    lines.push("", `${label} — ${formatUsd(String(totalUsd))}`);
    if (holdings.length === 0) {
      lines.push("• nothing above $0.01");
    } else {
      for (const h of holdings) {
        lines.push(`• ${trimAmount(h.amount)} ${h.symbol} (${formatUsd(String(h.valueUsd))})`);
      }
    }
  }

  const aggLines = [...aggregate.values()]
    .filter((a) => a.valueUsd >= MIN_USD)
    .sort((a, b) => b.valueUsd - a.valueUsd);
  lines.push("", `combined across all accounts — ${formatUsd(String(combinedTotalUsd))}`);
  if (aggLines.length === 0) {
    lines.push("• nothing above $0.01");
  } else {
    for (const a of aggLines) {
      lines.push(`• ${trimAmount(String(a.amount))} ${a.symbol} (${formatUsd(String(a.valueUsd))})`);
    }
  }

  return {
    data: { aggregated: true, wallets, perWallet, combinedTotalUsd },
    control: { type: "text", text: lines.join("\n") },
  };
}

// ── Tool handlers ─────────────────────────────────────────────────────────────

export async function get_wallet_balance(ctx: RespondCtx): Promise<ToolResult> {
  const check = custodialWalletOrError(ctx);
  if (!check.ok) return check.result;

  const userKey = portfolioUserKey(ctx);
  if (userKey) {
    try {
      const portfolio = await buildChannelPortfolio(ctx);
      if (portfolio) {
        return {
          data: { address: check.address, portfolioSummary: true },
          control: {
            type: "wallet_info",
            text: formatCoinsSummaryForImessage(portfolio),
            address: check.address,
            portfolioViewUrl:
              tryBuildSignedPortfolioUrl(userKey) ?? buildSignedPortfolioUrl(userKey),
            balances: portfolio.coins.slice(0, 3).map((coin) => ({
              symbol: coin.symbol,
              formatted: coin.amount,
            })),
          },
        };
      }
    } catch (err) {
      console.warn("⚠️ iMessage portfolio balance summary failed:", err);
    }
  }

  const wallets = selfWalletSet(ctx);
  if (wallets.length > 1) {
    return aggregatedWalletBalance(ctx, wallets, check.address);
  }

  let balances: Array<{ symbol: string; formatted: string }> = [];
  try {
    const all = await getBalances(check.address);
    balances = all
      .filter((b) => Number(b.formatted) > 0)
      .map((b) => ({ symbol: b.symbol, formatted: b.formatted }));
  } catch (err: any) {
    console.error("get_wallet_balance failed:", err?.message || err);
    return {
      data: { error: "balance lookup failed" },
      control: {
        type: "text",
        text: "couldn't fetch your balance right now — try again in a moment",
      },
    };
  }

  const lines =
    balances.length > 0
      ? balances.map((b) => `• ${trimAmount(b.formatted)} ${b.symbol}`).join("\n")
      : "• 0 USDC";
  const text = [
    "here's your basemate wallet 👇",
    "",
    lines,
    "",
    "your Base address is in the next message — tap to copy.",
    "fund it with a direct crypto deposit on Base, or say \"add funds\" to buy with Apple Pay.",
  ].join("\n");

  return {
    data: { address: check.address, balances },
    control: { type: "wallet_info", text, address: check.address, balances },
  };
}

export async function fund_wallet(
  ctx: RespondCtx,
  args: { amountUsd?: number },
): Promise<ToolResult> {
  const check = custodialWalletOrError(ctx);
  if (!check.ok) return check.result;

  let url: string;
  try {
    url = await buildOnrampUrl({
      address: check.address,
      partnerUserRef: ctx.inboxId,
      presetFiatAmount: args.amountUsd && args.amountUsd > 0 ? args.amountUsd : undefined,
      clientIp: ctx.clientIp,
    });
  } catch (err: any) {
    console.error("fund_wallet onramp link failed:", err?.message || err);
    return {
      data: { address: check.address, onramp: false },
      control: {
        type: "wallet_info",
        text: [
          "to add funds, send USDC or ETH on Base to your wallet address (next message).",
          "",
          "(card / Apple Pay onramp isn't available right now)",
        ].join("\n"),
        address: check.address,
        balances: [],
      },
    };
  }

  const text = [
    "two ways to add funds 👇",
    "",
    "1) Apple Pay / card — i'll send a Coinbase link you can tap",
    "2) crypto deposit — send USDC or ETH on Base to your wallet address (next message)",
  ].join("\n");

  return {
    data: { url, address: check.address },
    control: { type: "onramp_link", text, url, address: check.address },
  };
}

export async function sweep_funds(
  ctx: RespondCtx,
  args: { to?: string } = {},
): Promise<ToolResult> {
  const rawDestination = args.to?.trim();
  if (rawDestination && !isAddress(rawDestination)) {
    return {
      data: { error: "invalid destination" },
      control: {
        type: "text",
        text: "that doesn't look like a valid destination wallet — send a 0x address",
      },
    };
  }

  const platform =
    ctx.copyPlatform === "xmtp"
      ? "xmtp"
      : ctx.copyPlatform === "whatsapp"
        ? "whatsapp"
        : "imessage";
  const userKey =
    platform === "xmtp" ? ctx.inboxId : (ctx.copyUserKey ?? ctx.inboxId);
  const embedded = platform !== "xmtp" ? await WalletAdapter.getEmbeddedWallet(userKey) : null;
  const destination = rawDestination
    ? getAddress(rawDestination)
    : platform !== "xmtp"
      ? embedded?.address
      : ctx.walletAddress || (await UserAdapter.getWalletAddress(ctx.inboxId));

  if (!destination || !isAddress(destination)) {
    return {
      data: { error: "destination required" },
      control: {
        type: "text",
        text: "where should i sweep the funds? send `sweep to 0x...` with the destination wallet.",
      },
    };
  }

  const mainWallet =
    ctx.custodialWallet && ctx.walletAddress && ctx.custodialAccountName
      ? {
          label: "Main wallet",
          accountName: ctx.custodialAccountName,
          address: ctx.walletAddress,
        }
      : null;
  const targets = await resolveCustodialSweepWallets({
    platform,
    userKey,
    mainWallet,
  });

  return {
    data: { destination, targets, previewOnly: true },
    control: { type: "text", text: formatSweepPreview(targets, destination) },
  };
}

export async function withdraw_funds(
  ctx: RespondCtx,
  args: { to: string; amount: string; asset?: string },
): Promise<ToolResult> {
  const check = custodialWalletOrError(ctx);
  if (!check.ok) return check.result;
  if (!check.accountName) {
    return {
      data: { error: "cdp account required" },
      control: { type: "text", text: "withdrawal is only available for CDP custodial wallets — not supported here" },
    };
  }

  const to = (args.to || "").trim();
  const amount = (args.amount || "").trim();
  const asset: "usdc" | "eth" =
    (args.asset || "USDC").toLowerCase() === "eth" ? "eth" : "usdc";

  if (!isAddress(to)) {
    return {
      data: { error: "invalid address" },
      control: {
        type: "text",
        text: "that doesn't look like a valid 0x address — double-check and resend",
      },
    };
  }
  const amountNum = Number(amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    return {
      data: { error: "invalid amount" },
      control: { type: "text", text: "how much do you want to withdraw? give me an amount" },
    };
  }

  try {
    const balances = await getBalances(check.address);
    const usdc = Number(
      balances.find((b) => b.contractAddress === BASE_USDC_ADDRESS)?.formatted ?? "0",
    );
    const eth = Number(balances.find((b) => b.symbol === "ETH")?.formatted ?? "0");
    if (asset === "usdc" && amountNum > usdc) {
      return {
        data: { error: "insufficient usdc" },
        control: {
          type: "text",
          text: `you only have ${trimAmount(String(usdc))} USDC — can't withdraw ${trimAmount(amount)}`,
        },
      };
    }
    if (asset === "eth" && amountNum > eth) {
      return {
        data: { error: "insufficient eth" },
        control: {
          type: "text",
          text: `you only have ${trimAmount(String(eth))} ETH — can't withdraw ${trimAmount(amount)}`,
        },
      };
    }
    if (eth <= 0) {
      return {
        data: { error: "no gas" },
        control: {
          type: "text",
          text: "you need a little ETH on Base to cover gas before withdrawing — add some and try again",
        },
      };
    }
  } catch (err: any) {
    console.error("withdraw_funds balance check failed:", err?.message || err);
    // Non-fatal — fall through and let the transfer surface any error.
  }

  try {
    const label = `${trimAmount(amount)} ${asset.toUpperCase()} to ${shortenAddress(to)}`;
    const previewText = [
      `withdraw ${label}?`,
      "",
      `sending ${trimAmount(amount)} ${asset.toUpperCase()} to ${to}`,
      "",
      'reply "confirm" to proceed or "cancel" to abort',
    ].join("\n");
    return {
      data: { to, amount, asset, label, accountName: check.accountName, previewOnly: true },
      control: {
        type: "withdraw_preview",
        text: previewText,
        to,
        amount,
        asset,
        label,
        accountName: check.accountName,
      },
    };
  } catch (err: any) {
    console.error("withdraw_funds preview failed:", err?.message || err);
    return {
      data: { error: err?.message || "preview failed" },
      control: {
        type: "text",
        text: "couldn't prepare that withdrawal — check the address/amount and try again",
      },
    };
  }
}

export async function offramp_to_fiat(
  ctx: RespondCtx,
  args: { amount?: string },
): Promise<ToolResult> {
  const check = custodialWalletOrError(ctx);
  if (!check.ok) return check.result;

  let usdc = 0;
  try {
    usdc = Number(await getUsdcBalance(check.address));
  } catch {
    // best-effort; offramp page will still load
  }
  if (usdc <= 0) {
    return {
      data: { error: "no funds" },
      control: {
        type: "text",
        text: "you don't have any USDC to cash out yet — add funds first",
      },
    };
  }

  const requestedAmount = args.amount ? Number(args.amount) : 0;
  if (requestedAmount > 0 && requestedAmount > usdc) {
    return {
      data: { error: "insufficient balance" },
      control: {
        type: "text",
        text: `you only have ${trimAmount(String(usdc))} USDC — can't cash out ${trimAmount(String(requestedAmount))}`,
      },
    };
  }

  let url: string;
  try {
    const coinbaseUrl = await buildOfframpUrl({
      address: check.address,
      partnerUserRef: ctx.inboxId,
      presetCryptoAmount: args.amount?.trim() || undefined,
      clientIp: ctx.clientIp,
    });
    const token = await FundSessionAdapter.create(ctx.inboxId, coinbaseUrl);
    url = `${config.cdp.fundPageUrl}?s=${token}`;
  } catch (err: any) {
    console.error("offramp_to_fiat link failed:", err?.message || err);
    return {
      data: { error: "offramp unavailable" },
      control: {
        type: "text",
        text: "cash-out isn't available right now — try again later",
      },
    };
  }

  const text = "tap below to cash out to fiat (bank, PayPal, or Coinbase) — opens Coinbase:";
  return {
    data: { url },
    control: { type: "offramp_link", text, url },
  };
}

/**
 * Resolve a send recipient through all outcomes, in priority order:
 *   1. 0x address, 2. basename/ENS, 3. saved contact name -> their wallet.
 * Contact resolution makes the LLM send path handle "send Bob 5 usdc" the same
 * as "send 5 usdc to bob.base.eth" — recipients no longer have to be addresses.
 * When a saved contact is known, `display` is always human (name + phone), never 0x.
 */
async function resolveRecipientWithContacts(
  ctx: RespondCtx,
  to: string,
): Promise<
  { address: string; display: string; phone?: string | null } | { error: string }
> {
  const senderId = ctx.inboxId;
  if (!senderId) {
    return {
      error:
        `i don't have a wallet or saved contact for "${to.trim()}". ` +
        `share their contact, or send to a 0x address or basename (name.base.eth).`,
    };
  }

  const { resolveSendTarget } = await import("@/messaging/resolveSendTarget.js");
  const trimmed = to.trim();
  const isAddress = /^0x[a-fA-F0-9]{40}$/i.test(trimmed);
  const isEns = /\.(base\.)?eth$/i.test(trimmed);
  const target = await resolveSendTarget(senderId, {
    address: isAddress || isEns ? trimmed : undefined,
    name: !isAddress && !isEns ? trimmed : undefined,
  });

  if (target.kind === "wallet") {
    return {
      address: target.address,
      display: target.display,
      phone: target.phone,
    };
  }
  if (target.kind === "claim_phone") {
    return {
      error:
        `${target.name ?? trimmed} is saved (${target.phone}) but hasn't linked a wallet yet. ` +
        `say "send … to ${target.name ?? trimmed}" again and confirm so they can claim it — ` +
        `or ask them to open Basemate and connect their Basemate wallet.`,
    };
  }
  if (target.kind === "ambiguous") {
    const options = target.candidates
      .map((c) => (c.phone ? `${c.name} (${c.phone})` : c.name))
      .join(", ");
    return {
      error: `i found a few contacts that could match "${trimmed}": ${options}. which one did you mean?`,
    };
  }
  return {
    error:
      `i don't have a wallet or saved contact for "${trimmed}". ` +
      `share their contact, or send to a 0x address or basename (name.base.eth).`,
  };
}

export async function send_token(
  ctx: RespondCtx,
  args: {
    to: string;
    asset: string;
    amount: string;
    isUsd?: boolean;
    all?: boolean;
    memo?: string;
  },
): Promise<ToolResult> {
  const token = await resolveTokenAsync(args.asset);
  if (!token.resolved) {
    return {
      data: { error: `Unresolved token: ${args.asset}` },
      control: {
        type: "text",
        text: `couldn't find ${args.asset} on Base. paste the contract address and i'll send it.`,
      },
    };
  }

  const wantsAll =
    args.all === true || ALL_AMOUNT_RE.test((args.amount ?? "").trim());

  let amount: string;
  let isUsd = args.isUsd ?? false;
  const memo =
    typeof args.memo === "string" && args.memo.trim() ? args.memo.trim() : undefined;

  if (wantsAll) {
    if (!ctx.walletAddress) {
      return {
        data: { error: "wallet unavailable" },
        control: {
          type: "text",
          text: "connect your wallet and i'll send your full balance.",
        },
      };
    }
    const bal = await readWalletTokenBalance(ctx.walletAddress, token);
    if ("error" in bal) {
      return { data: { error: bal.error }, control: { type: "text", text: bal.error } };
    }
    amount = bal.amount;
    isUsd = false;
  } else {
    const sanitized = resolveSendAmount(args.amount);
    if (!sanitized) {
      return {
        data: { error: "Invalid amount" },
        control: { type: "text", text: "What amount should I send?" },
      };
    }
    amount = sanitized;
    ({ amount, isUsd } = resolveUsdQuotedSwapAmount({
      modelAmount: amount,
      userMessage: ctx.userMessage,
      fromStablecoin: isStablecoinAddress(token.address),
      isUsd,
    }));
  }

  let usdSpend: string | undefined;
  if (isUsd) {
    usdSpend = amount;
    const limitErr = assertSwapUsdWithinLimit(amount);
    if (limitErr) {
      return { data: { error: limitErr }, control: { type: "text", text: limitErr } };
    }
    const converted = await usdToTokenAmount(amount, token);
    if ("error" in converted) {
      return {
        data: { error: "Price unavailable" },
        control: { type: "text", text: converted.error },
      };
    }
    amount = converted.amount;
  }

  const resolved = await resolveRecipientWithContacts(ctx, args.to);
  if ("error" in resolved) {
    return {
      data: { error: resolved.error },
      control: { type: "text", text: resolved.error },
    };
  }
  const toAddress = resolved.address;
  const recipientLabel = resolved.display;

  // $0-wallet nudge: a brand-new user with an empty wallet gets pointed at Add
  // Funds instead of a confusing on-chain failure. Only fires on a confirmed
  // zero balance (not an RPC hiccup). Guarded on a known wallet address, so it
  // is skipped in unit tests (which run without one) and by `all` sends (which
  // already read the balance above).
  if (ctx.walletAddress && !wantsAll) {
    const bal = await readWalletTokenBalance(ctx.walletAddress, token);
    if ("error" in bal && /don'?t have (any|enough)/i.test(bal.error)) {
      const depositHint = usdSpend ? `$${usdSpend}` : "$20";
      return {
        data: { error: "insufficient_balance", nudge: "onramp" },
        control: {
          type: "text",
          text:
            `you don't have any ${token.symbol} to send yet — add funds first. ` +
            `say "deposit ${depositHint}" and i'll pull up Apple Pay, then resend to ${recipientLabel}.`,
        },
      };
    }
  }

  const usdLabel = usdSpend ? ` ($${usdSpend})` : "";
  const allLabel = wantsAll ? " (all)" : "";
  const memoLabel = memo ? ` — ${memo}` : "";
  let label = `Send ${amount} ${token.symbol}${usdLabel}${allLabel} to ${recipientLabel}${memoLabel}`;
  const callMetadata = {
    description: label,
    transactionType: "transfer",
    ...(usdSpend ? { amountUsd: usdSpend } : {}),
    ...(memo ? { memo } : {}),
  };

  // When the recipient came from a saved contact with a phone, carry the
  // notification metadata so the handler can text them once it confirms —
  // regardless of how the send was phrased.
  let contactTransfer =
    "phone" in resolved && resolved.phone
      ? {
          recipientPhone: resolved.phone,
          amount,
          asset: token.symbol,
          ...(memo ? { memo } : {}),
        }
      : undefined;

  try {
    if (token.address === "ETH") {
      const valueHex = toHex(parseUnits(amount, 18));
      const calls: WalletCall[] = [
        { to: toAddress as Address, value: valueHex, data: "0x", metadata: callMetadata },
      ];
      return {
        data: { calls, chainId: "0x2105" },
        control: {
          type: "transaction",
          text: label,
          calls,
          chainId: "0x2105" as `0x${string}`,
          ...(contactTransfer ? { contactTransfer } : {}),
        },
      };
    }

    // Corridor auto-swap: USDC → local stable when sending to a mapped phone.
    if (
      contactTransfer?.recipientPhone &&
      ctx.walletAddress &&
      !wantsAll
    ) {
      const { isUsdSendAsset, resolveCorridorStable } = await import(
        "@/portfolio/corridorRouting.js"
      );
      const { buildCorridorSendCalls } = await import("@/portfolio/corridorSend.js");
      if (isUsdSendAsset(token.symbol)) {
        const corridor = resolveCorridorStable(contactTransfer.recipientPhone);
        if (corridor?.address) {
          const routed = await buildCorridorSendCalls({
            mode: "transfer",
            usdcAmount: amount,
            localStable: corridor,
            senderAddress: ctx.walletAddress,
            recipientAddress: toAddress,
            phone: contactTransfer.recipientPhone,
          });
          if (!routed.fallback) {
            label =
              `Convert ${amount} USDC → ~${routed.quotedLocalAmount} ${corridor.symbol} ` +
              `and send to ${recipientLabel}${memoLabel}`;
            contactTransfer = {
              ...contactTransfer,
              amount: routed.localAmount,
              asset: corridor.symbol,
            };
            return {
              data: { calls: routed.calls, chainId: "0x2105", corridor: corridor.symbol },
              control: {
                type: "transaction",
                text: label,
                calls: routed.calls,
                chainId: "0x2105" as `0x${string}`,
                contactTransfer,
              },
            };
          }
        }
      }
    }

    {
      const rawAmount = parseUnits(amount, token.decimals);
      const data = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [toAddress as Address, rawAmount],
      });
      const calls: WalletCall[] = [
        { to: token.address as Address, value: "0x0", data, metadata: callMetadata },
      ];
      return {
        data: { calls, chainId: "0x2105" },
        control: {
          type: "transaction",
          text: label,
          calls,
          chainId: "0x2105" as `0x${string}`,
          ...(contactTransfer ? { contactTransfer } : {}),
        },
      };
    }
  } catch (err) {
    return {
      data: { error: String(err) },
      control: {
        type: "text",
        text: `Failed to build the send transaction: ${String(err)}`,
      },
    };
  }
}

export async function send_token_bundle(
  ctx: RespondCtx,
  args: {
    to: string;
    transfers: Array<{ asset: string; amount: string; isUsd?: boolean }>;
    label?: string;
  },
): Promise<ToolResult> {
  const resolved = await resolveRecipientWithContacts(ctx, args.to);
  if ("error" in resolved) {
    return {
      data: { error: resolved.error },
      control: { type: "text", text: resolved.error },
    };
  }
  const toAddress = resolved.address;
  const recipientLabel = resolved.display;

  const calls: WalletCall[] = [];
  const parts: string[] = [];

  for (const transfer of args.transfers) {
    const token = await resolveTokenAsync(transfer.asset);
    if (!token.resolved) {
      return {
        data: { error: `Unresolved token: ${transfer.asset}` },
        control: {
          type: "text",
          text: `couldn't find ${transfer.asset} on Base. paste the contract address and i'll send it.`,
        },
      };
    }

    let amount = sanitizeAmount(transfer.amount);
    if (!amount) {
      return {
        data: { error: "Invalid amount" },
        control: { type: "text", text: "What amount should I send?" },
      };
    }

    let isUsd = transfer.isUsd ?? false;
    ({ amount, isUsd } = resolveUsdQuotedSwapAmount({
      modelAmount: amount,
      userMessage: ctx.userMessage,
      fromStablecoin: isStablecoinAddress(token.address),
      isUsd,
    }));

    let usdSpend: string | undefined;
    if (isUsd) {
      usdSpend = amount;
      const limitErr = assertSwapUsdWithinLimit(amount);
      if (limitErr) {
        return { data: { error: limitErr }, control: { type: "text", text: limitErr } };
      }
      const converted = await usdToTokenAmount(amount, token);
      if ("error" in converted) {
        return {
          data: { error: "Price unavailable" },
          control: { type: "text", text: converted.error },
        };
      }
      amount = converted.amount;
    }

    const usdLabel = usdSpend ? ` ($${usdSpend})` : "";
    parts.push(`${amount} ${token.symbol}${usdLabel}`);

    const callMetadata = {
      description: `Send ${amount} ${token.symbol}${usdLabel} to ${recipientLabel}`,
      transactionType: "transfer",
      ...(usdSpend ? { amountUsd: usdSpend } : {}),
    };

    try {
      if (token.address === "ETH") {
        const valueHex = toHex(parseUnits(amount, 18));
        calls.push({
          to: toAddress as Address,
          value: valueHex,
          data: "0x",
          metadata: callMetadata,
        });
      } else {
        const rawAmount = parseUnits(amount, token.decimals);
        const data = encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "transfer",
          args: [toAddress as Address, rawAmount],
        });
        calls.push({
          to: token.address as Address,
          value: "0x0",
          data,
          metadata: callMetadata,
        });
      }
    } catch (err) {
      return {
        data: { error: String(err) },
        control: {
          type: "text",
          text: `Failed to build the send transaction: ${String(err)}`,
        },
      };
    }
  }

  const label = args.label ?? `Send ${parts.join(" + ")} to ${recipientLabel}`;
  const contactTransfer =
    "phone" in resolved && resolved.phone
      ? { recipientPhone: resolved.phone, amount: parts.join(" + "), asset: "" }
      : undefined;
  return {
    data: { calls, chainId: "0x2105" },
    control: {
      type: "transaction",
      text: label,
      calls,
      chainId: "0x2105" as `0x${string}`,
      ...(contactTransfer ? { contactTransfer } : {}),
    },
  };
}

/**
 * Resolve a Basename / ENS name → address, or reverse-resolve an address → name.
 */
export async function resolve_name(
  _ctx: RespondCtx,
  args: { name: string },
): Promise<ToolResult> {
  const raw = (args.name ?? "").trim().replace(/^@+/, "");
  if (!raw) {
    return {
      data: { error: "missing name" },
      control: {
        type: "text",
        text: "which basename, ens name, or 0x address should i look up?",
      },
    };
  }

  if (ETH_ADDRESS_RE.test(raw) || /^0x[a-fA-F0-9]{40}$/i.test(raw)) {
    const address = raw.toLowerCase();
    const name = await resolveBasename(address);
    if (name) {
      return {
        data: { address, name },
        control: {
          type: "text",
          text: `${shortenAddress(address)} → ${name}`,
        },
      };
    }
    return {
      data: { address, name: null },
      control: {
        type: "text",
        text: `${shortenAddress(address)} doesn't have a primary basename or ens name set.`,
      },
    };
  }

  if (!raw.includes(".")) {
    return {
      data: { error: "bare handle" },
      control: {
        type: "text",
        text: "need a full basename (name.base.eth), ens name (name.eth), or 0x address — bare @handles aren't supported.",
      },
    };
  }

  const address = await resolveEnsNameForward(raw);
  if (!address) {
    return {
      data: { error: "unresolved", name: raw },
      control: {
        type: "text",
        text: `couldn't resolve "${raw}" to a wallet address. check the basename or paste a 0x address.`,
      },
    };
  }

  return {
    data: { name: raw, address },
    control: {
      type: "text",
      text: `${raw} → ${address}`,
    },
  };
}
