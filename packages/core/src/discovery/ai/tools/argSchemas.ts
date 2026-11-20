/**
 * argSchemas — Zod validation schemas for the 5 high-risk tool categories.
 *
 * These are the tools that construct on-chain calldata (send, swap) or
 * open/close financial positions (perp open/close). A hallucinated field
 * (wrong key name, wrong type, missing required value) would either crash
 * the handler silently or — worse — submit malformed calldata on-chain.
 *
 * Usage: `validateToolArgs(toolName, rawArgs)` returns a discriminated result.
 * On `ok: false` the caller should return a user-facing error rather than
 * invoking the handler.
 *
 * Other tools (search, balance checks, etc.) are lower-risk and fall through
 * to the handler with the unvalidated args — the existing `sanitizeAmount` /
 * `resolveTokenAsync` checks cover them adequately.
 */

import { z } from "zod";

// ── Reusable sub-schemas ──────────────────────────────────────────────────────

const zNonEmptyString = z.string().min(1);
const zOptionalAmount = z.string().optional();
const zAmountOrUsd = z.object({
  amount: zNonEmptyString,
  isUsd: z.boolean().optional(),
});

// ── send ─────────────────────────────────────────────────────────────────────

export const sendTokenSchema = z.object({
  to: zNonEmptyString,
  asset: zNonEmptyString,
  amount: zNonEmptyString, // numeric string, or "all" / "max" / "everything"
  isUsd: z.boolean().optional(),
  all: z.boolean().optional(),
  memo: z.string().optional(),
});

export const sendTokenBundleSchema = z.object({
  to: zNonEmptyString,
  transfers: z
    .array(
      z.object({
        asset: zNonEmptyString,
        amount: zNonEmptyString,
        isUsd: z.boolean().optional(),
      }),
    )
    .min(1),
});

export const giftStockSchema = z.object({
  to: zNonEmptyString,
  stock: zNonEmptyString,
  amount: zNonEmptyString,
  isUsd: z.boolean().optional(),
  memo: z.string().optional(),
});

// ── swap ─────────────────────────────────────────────────────────────────────

export const swapSchema = z.object({
  fromAsset: zNonEmptyString,
  toAsset: zNonEmptyString,
  amount: zNonEmptyString,
  isUsd: z.boolean().optional(),
});

// reused for both Uniswap and Aerodrome (same arg shape)
export const aerodromeSwapSchema = swapSchema;

// ── yield deposit ─────────────────────────────────────────────────────────────

const yieldDepositBase = z.object({
  asset: zNonEmptyString,
  amount: zOptionalAmount,
  isUsd: z.boolean().optional(),
});

export const morphoDepositSchema = yieldDepositBase.extend({
  vaultName: z.string().optional(),
});

export const aaveSupplySchema = yieldDepositBase;
export const moonwellSupplySchema = yieldDepositBase;

// ── perp open ────────────────────────────────────────────────────────────────

export const avantisPrepareTrade = z.object({
  pair: zNonEmptyString,
  side: z.enum(["long", "short"]),
  leverage: z.number().positive().optional(),
  collateral: z.string().optional(),
  orderType: z.enum(["market", "limit"]).optional(),
  openPrice: z.string().optional(),
  takeProfit: z.string().optional(),
  stopLoss: z.string().optional(),
});

// ── perp close ───────────────────────────────────────────────────────────────

export const avantisClosePosition = z.object({
  pair: z.string().optional(),
  pairIndex: z.number().int().nonnegative().optional(),
  tradeIndex: z.number().int().nonnegative().optional(),
  collateralToClose: z.string().optional(),
  walletScope: z.string().optional(),
});

export const avantisCancelLimit = z.object({
  pair: z.string().optional(),
  pairIndex: z.number().int().nonnegative().optional(),
  tradeIndex: z.number().int().nonnegative().optional(),
  walletScope: z.string().optional(),
});

// ── Flash advanced spot ───────────────────────────────────────────────────────

export const flashPrepareOrder = z.object({
  targetAsset: zNonEmptyString,
  contraAsset: zNonEmptyString,
  side: z.enum(["buy", "sell"]),
  qty: zNonEmptyString,
  orderType: z.enum(["market", "limit", "twap", "stop", "stop-loss", "take-profit", "bracket"]),
  limitNotionalPrice: z.string().optional(),
  triggerNotionalPrice: z.string().optional(),
  triggerType: z.enum(["upper", "lower"]).optional(),
  durationSeconds: z.number().int().positive().optional(),
  twapBucketCount: z.number().int().min(2).max(2560).optional(),
  maxSlippage: z.string().optional(),
});

export const flashCancelOrder = z.object({
  orderId: zNonEmptyString,
});

// ── Dispatch map ─────────────────────────────────────────────────────────────

/**
 * Maps tool name → Zod schema. Only the 5 high-risk categories are listed;
 * everything else is not validated here (falls through to handler).
 */
const TOOL_ARG_SCHEMAS: Record<string, z.ZodTypeAny> = {
  send_token: sendTokenSchema,
  send_token_bundle: sendTokenBundleSchema,
  gift_stock: giftStockSchema,
  uniswap_prepare_swap: swapSchema,
  aerodrome_prepare_swap: aerodromeSwapSchema,
  morpho_prepare_deposit: morphoDepositSchema,
  aave_prepare_supply: aaveSupplySchema,
  moonwell_prepare_supply: moonwellSupplySchema,
  avantis_prepare_trade: avantisPrepareTrade,
  avantis_close_position: avantisClosePosition,
  avantis_cancel_limit: avantisCancelLimit,
  flash_prepare_order: flashPrepareOrder,
  flash_cancel_order: flashCancelOrder,
};

export type ValidateArgsOk = { ok: true; args: Record<string, unknown> };
export type ValidateArgsErr = {
  ok: false;
  toolName: string;
  issues: string;
};

/**
 * Validate `rawArgs` against the registered schema for `toolName`.
 *
 * Returns `{ ok: true, args }` (with the Zod-coerced values) on success, or
 * `{ ok: false, issues }` on failure. If no schema is registered for the tool
 * the raw args pass through unchanged (`ok: true`).
 */
export function validateToolArgs(
  toolName: string,
  rawArgs: Record<string, unknown>,
): ValidateArgsOk | ValidateArgsErr {
  const schema = TOOL_ARG_SCHEMAS[toolName];
  if (!schema) return { ok: true, args: rawArgs };

  const result = schema.safeParse(rawArgs);
  if (result.success) {
    return { ok: true, args: result.data as Record<string, unknown> };
  }

  const issues = result.error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  return { ok: false, toolName, issues };
}
