import type { Address } from "viem";

const CACHE_TTL_MS = 60 * 60 * 1000;

// Base mainnet Basenames contracts — https://github.com/base/basenames
const BASE_REGISTRY = "0xb94704422c2a1e396835a571837aa5ae53285a95" as const;
const BASE_REVERSE_REGISTRAR = "0x79ea96012eea67a83431f1701b3dff7e37f9e282" as const;

const reverseNodeAbi = [
  {
    name: "node",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "address", name: "addr" }],
    outputs: [{ type: "bytes32" }],
  },
] as const;

const registryResolverAbi = [
  {
    name: "resolver",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "bytes32", name: "node" }],
    outputs: [{ type: "address" }],
  },
] as const;

const resolverNameAbi = [
  {
    name: "name",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "bytes32", name: "node" }],
    outputs: [{ type: "string" }],
  },
] as const;

const basenameCache = new Map<string, { name: string | null; expiresAt: number }>();

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

type EnsdataReverseResponse = {
  ens_primary?: string;
  ens?: string;
  error?: boolean;
};

/**
 * Reverse-resolve a wallet to its primary Basename / ENS label.
 * Basenames primary path: read L2 ReverseRegistrar on Base (ENSIP-19).
 * Fallbacks: ensdata.net, then viem getEnsName on mainnet with Base coin type.
 */
export async function resolveBasename(address: string): Promise<string | null> {
  const key = address.toLowerCase();
  const cached = basenameCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.name;

  let name =
    (await lookupViaBaseReverseRegistrar(key as Address)) ||
    (await lookupViaEnsdata(key)) ||
    (await lookupViaViem(key as Address));

  if (name === "") name = null;

  basenameCache.set(key, { name, expiresAt: Date.now() + CACHE_TTL_MS });
  return name;
}

export async function resolveTraderDisplayLabel(
  wallet?: string,
  traderLabel?: string,
): Promise<string> {
  if (traderLabel) return traderLabel;
  if (!wallet) return "someone";
  const basename = await resolveBasename(wallet);
  return basename ?? truncateAddress(wallet);
}

type EnsdataForwardResponse = {
  address?: string;
  wallets?: { base?: string; eth?: string };
  error?: boolean;
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const resolverAddrAbi = [
  {
    name: "addr",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "bytes32", name: "node" }],
    outputs: [{ type: "address" }],
  },
] as const;

function asEthAddress(addr: string | null | undefined): string | null {
  if (!addr?.startsWith("0x") || addr.length !== 42) return null;
  if (addr.toLowerCase() === ZERO_ADDRESS) return null;
  return addr.toLowerCase();
}

async function lookupForwardViaEnsdata(name: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.ensdata.net/${encodeURIComponent(name)}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as EnsdataForwardResponse;
    if (json.error) return null;
    return asEthAddress(json.address ?? json.wallets?.base ?? json.wallets?.eth);
  } catch {
    return null;
  }
}

/** L1 Universal Resolver (CCIP-read) with Base coin type — works for .eth and .base.eth. */
async function lookupForwardViaViem(name: string): Promise<string | null> {
  try {
    const { createPublicClient, http, toCoinType } = await import("viem");
    const { normalize } = await import("viem/ens");
    const { mainnet } = await import("viem/chains");
    const client = createPublicClient({
      chain: mainnet,
      transport: http(process.env.ETH_RPC_URL ?? process.env.MAINNET_RPC_URL ?? "https://cloudflare-eth.com"),
    });
    const normalized = normalize(name);
    const result = await Promise.race([
      client.getEnsAddress({ name: normalized, coinType: toCoinType(8453) }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 6000)),
    ]);
    return asEthAddress(result ?? undefined);
  } catch {
    return null;
  }
}

/** Direct Base L2 registry + resolver read for *.base.eth / *.cb.id. */
async function lookupForwardViaBaseRegistry(name: string): Promise<string | null> {
  if (!/\.(base\.)?eth$/i.test(name) && !/\.cb\.id$/i.test(name)) return null;
  try {
    const { createPublicClient, http, namehash } = await import("viem");
    const { base } = await import("viem/chains");
    const client = createPublicClient({
      chain: base,
      transport: http(process.env.BASE_RPC_URL ?? "https://mainnet.base.org"),
    });
    const node = namehash(name);
    const resolver = await Promise.race([
      client.readContract({
        address: BASE_REGISTRY,
        abi: registryResolverAbi,
        functionName: "resolver",
        args: [node],
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);
    if (!resolver || resolver === ZERO_ADDRESS) return null;
    const addr = await Promise.race([
      client.readContract({
        address: resolver,
        abi: resolverAddrAbi,
        functionName: "addr",
        args: [node],
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);
    return asEthAddress(addr ?? undefined);
  } catch {
    return null;
  }
}

/**
 * Forward-resolve a full ENS/Basename (e.g. alice.base.eth) → wallet.
 * Tries ensdata.net, then viem L1 Universal Resolver, then Base L2 registry.
 */
export async function resolveEnsNameForward(name: string): Promise<string | null> {
  const trimmed = name.trim().replace(/^@+/, "").toLowerCase();
  if (!trimmed.includes(".")) return null;

  return (
    (await lookupForwardViaEnsdata(trimmed)) ||
    (await lookupForwardViaViem(trimmed)) ||
    (await lookupForwardViaBaseRegistry(trimmed))
  );
}

/** Bare label from a basename (degeneer03.base.eth → degeneer03). */
export function basenameBareLabel(name: string): string {
  return name.trim().replace(/^@+/, "").replace(/\.(base\.)?eth$/i, "").replace(/\.cb\.id$/i, "").toLowerCase();
}

/** Deterministic Base/Coinbase names for a bare @handle — no suffix guessing. */
export function canonicalNamesForBareHandle(handle: string): string[] {
  const base = basenameBareLabel(handle);
  if (!base || base.startsWith("0x")) return [];
  return [`${base}.base.eth`, `${base}.cb.id`];
}

async function lookupViaBaseReverseRegistrar(address: Address): Promise<string | null> {
  try {
    const { createPublicClient, http } = await import("viem");
    const { base } = await import("viem/chains");
    const client = createPublicClient({
      chain: base,
      transport: http(process.env.BASE_RPC_URL ?? "https://mainnet.base.org"),
    });
    const reverseNode = await client.readContract({
      address: BASE_REVERSE_REGISTRAR,
      abi: reverseNodeAbi,
      functionName: "node",
      args: [address],
    });
    const resolver = await client.readContract({
      address: BASE_REGISTRY,
      abi: registryResolverAbi,
      functionName: "resolver",
      args: [reverseNode],
    });
    if (!resolver || resolver === "0x0000000000000000000000000000000000000000") {
      return null;
    }
    const name = await client.readContract({
      address: resolver,
      abi: resolverNameAbi,
      functionName: "name",
      args: [reverseNode],
    });
    return name || null;
  } catch {
    return null;
  }
}

async function lookupViaEnsdata(address: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.ensdata.net/${address}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as EnsdataReverseResponse;
    if (json.error) return null;
    return json.ens_primary || json.ens || null;
  } catch {
    return null;
  }
}

async function lookupViaViem(address: Address): Promise<string | null> {
  try {
    const { createPublicClient, http, toCoinType } = await import("viem");
    const { mainnet } = await import("viem/chains");
    const client = createPublicClient({
      chain: mainnet,
      transport: http(process.env.ETH_RPC_URL ?? "https://cloudflare-eth.com"),
    });
    const result = await Promise.race([
      client.getEnsName({ address, coinType: toCoinType(8453) }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 6000)),
    ]);
    return result ?? null;
  } catch {
    return null;
  }
}
