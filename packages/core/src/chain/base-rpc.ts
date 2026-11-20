import process from "node:process";

/** Base mainnet JSON-RPC URL — prefers explicit BASE_RPC_URL, then Alchemy, then the public endpoint. */
export function resolveBaseRpcUrl(): string {
  const explicit = process.env.BASE_RPC_URL?.trim();
  if (explicit) return explicit;

  const alchemyKey = process.env.ALCHEMY_API_KEY?.trim();
  if (alchemyKey) return `https://base-mainnet.g.alchemy.com/v2/${alchemyKey}`;

  return "https://mainnet.base.org";
}
