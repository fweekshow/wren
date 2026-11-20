import { keccak256, toBytes, type Address } from "viem";

/** B20Factory precompile — same on every Base network. */
export const B20_FACTORY = "0xB20f000000000000000000000000000000000000" as Address;

export const B20_ACTIVATION_REGISTRY =
  "0x8453000000000000000000000000000000000001" as Address;

/** Uniswap V4 on Base mainnet. */
export const V4_POOL_MANAGER =
  "0x498581fF718922c3f8e6A244956aF099B2652b2b" as Address;
export const V4_POSITION_MANAGER =
  "0x7C5f5A4bBd8fD63184577525326123B519429bDc" as Address;
export const V4_STATE_VIEW =
  "0xa3c0c9b65baD0b08107Aa264b0f3dB444b867A71" as Address;

export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;

export const B20_VARIANT_ASSET = 0;
export const B20_ASSET_CREATE_PARAMS_VERSION = 1;
export const B20_ASSET_DECIMALS = 18;

/** keccak256("MINT_ROLE") — Solidity bytes32 role id. */
export const MINT_ROLE = keccak256(toBytes("MINT_ROLE"));

export const V4_FEE_MEDIUM = 3000;
export const V4_TICK_SPACING_MEDIUM = 60;
export const V4_MIN_TICK = -887272;
export const V4_MAX_TICK = 887272;

export const V4_ACTION_MINT_POSITION = 0x02;
export const V4_ACTION_SETTLE_PAIR = 0x0d;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

export const B20_DEFAULT_INITIAL_SUPPLY = 1_000_000_000n * 10n ** 18n;
export const B20_DEFAULT_LAUNCH_MCAP_USD = 50_000;

export function isLaunchpadMode(): boolean {
  return process.env.XMTP_LAUNCHPAD_MODE === "true";
}

export function b20LpRecipient(fallback: Address): Address {
  const raw = process.env.B20_LP_RECIPIENT?.trim();
  if (raw && raw.startsWith("0x") && raw.length === 42) return raw as Address;
  return fallback;
}
