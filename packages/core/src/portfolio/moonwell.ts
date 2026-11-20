import { createPublicClient, formatUnits, http, type Address } from "viem";
import { base } from "viem/chains";

import { resolveBaseRpcUrl } from "@/chain/base-rpc.js";

export interface MoonwellDirectSupply {
  symbol: string;
  mTokenSymbol: string;
  mTokenBalance: number;
  underlyingAmount: number | null;
}

export interface MoonwellVaultSupply {
  symbol: string;
  vaultSymbol: string;
  vaultName: string;
  vaultAddress: Address;
  shareBalance: number;
  underlyingAmount: number;
}

export const MOONWELL_MTOKEN_ABI = [
  {
    name: "balanceOf",
    type: "function",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    name: "decimals",
    type: "function",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
  },
  {
    name: "exchangeRateStored",
    type: "function",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    name: "convertToAssets",
    type: "function",
    inputs: [{ name: "shares", type: "uint256" }],
    outputs: [{ name: "assets", type: "uint256" }],
    stateMutability: "view",
  },
  {
    name: "mint",
    type: "function",
    inputs: [{ name: "mintAmount", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    name: "redeem",
    type: "function",
    inputs: [{ name: "redeemTokens", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    name: "redeemUnderlying",
    type: "function",
    inputs: [{ name: "redeemAmount", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
  },
] as const;

// Moonwell mToken addresses on Base mainnet (source: docs.moonwell.fi/moonwell/protocol-information/contracts).
export const MOONWELL_MTOKENS: Record<string, Address> = {
  USDC: "0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22",
  USDBC: "0x703843C3379b52F9FF486c9f5892218d2a065cC8",
  DAI: "0x73b06D8d18De422E269645eaCe15400DE7462417",
  USDS: "0xb6419c6C2e60c4025D6D06eE4F913ce89425a357",
  EURC: "0xb682c840B5F4FC58B20769E691A6fa1305A501a2",
  WETH: "0x628ff693426583D9a7FB391E54366292F509D457",
  CBETH: "0x3bf93770f2d4a794c3d9EBEfBAeBAE2a8f09A5E5",
  WSTETH: "0x627Fe393Bc6EdDA28e99AE648fD6fF362514304b",
  RETH: "0xcb1dacd30638ae38f2b94ea64f066045b7d45f44",
  WEETH: "0xb8051464C8c92209C92F3a4CD9C73746C4c3CFb3",
  WRSETH: "0xfC41B49d064Ac646015b459C522820DB9472F4B5",
  CBBTC: "0xF877ACaFA28c19b96727966690b2f44d35aD5976",
  TBTC: "0x9A858ebfF1bEb0D3495BB0e2897c1528eD84A218",
  LBTC: "0x10fF57877b79e9bd949B3815220eC87B9fc5D2ee",
  CBXRP: "0xb4fb8fed5b3AaA8434f0B19b1b623d977e07e86d",
  AERO: "0x73902f619CEB9B31FD8EFecf435CbDf89E369Ba6",
  WELL: "0xdC7810B47eAAb250De623F0eE07764afa5F71ED1",
  VIRTUAL: "0xdE8Df9d942D78edE3Ca06e60712582F79CFfFC64",
  MORPHO: "0x6308204872bdb7432df97b04b42443c714904f3e",
  MAMO: "0x2F90Bb22eB3979f5FfAd31EA6C3F0792ca66dA32",
  VVV: "0xd64bcb70c613a6d1f4d7d57ba64bb4a0767a9682",
};

export const MOONWELL_MTOKEN_ADDRESSES = new Set(
  Object.values(MOONWELL_MTOKENS).map((address) => address.toLowerCase()),
);

export const MOONWELL_VAULTS: Record<string, { address: Address; symbol: string; name: string }> = {
  USDC: {
    address: "0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca",
    symbol: "mwUSDC",
    name: "Moonwell Flagship USDC",
  },
  WETH: {
    address: "0xa0E430870c4604CcfC7B38Ca7845B1FF653D0ff1",
    symbol: "mwETH",
    name: "Moonwell Flagship ETH",
  },
  EURC: {
    address: "0xf24608E0CCb972b0b0f4A6446a0BBf58c701a026",
    symbol: "mwEURC",
    name: "Moonwell Flagship EURC",
  },
  CBBTC: {
    address: "0x543257ef2161176d7c8cd90ba65c2d4caef5a796",
    symbol: "mwcbBTC",
    name: "Moonwell Flagship cbBTC",
  },
};

export const MOONWELL_VAULT_ADDRESSES = new Set(
  Object.values(MOONWELL_VAULTS).map((vault) => vault.address.toLowerCase()),
);

export const MOONWELL_UNDERLYING_TOKENS: Record<string, { address: Address; decimals: number }> = {
  USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
  USDBC: { address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", decimals: 6 },
  DAI: { address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", decimals: 18 },
  USDS: { address: "0x820C137D761430A8E5A3571D3e0Eb24b9C02Ad7E", decimals: 18 },
  EURC: { address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", decimals: 6 },
  WETH: { address: "0x4200000000000000000000000000000000000006", decimals: 18 },
  CBETH: { address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", decimals: 18 },
  WSTETH: { address: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", decimals: 18 },
  RETH: { address: "0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c", decimals: 18 },
  WEETH: { address: "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A", decimals: 18 },
  WRSETH: { address: "0xEDfa23602D0EC14714057867A78d01e94176BEA0", decimals: 18 },
  CBBTC: { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8 },
  TBTC: { address: "0x236aa50979D5f3De3Bd1Eeb40E81137F22ab794b", decimals: 18 },
  LBTC: { address: "0xecAc9C5F704e954931349Da37F60E39f515c11c1", decimals: 8 },
  CBXRP: { address: "0xcb585250f852C6c6bf90434AB21A00f02833a4af", decimals: 6 },
  AERO: { address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", decimals: 18 },
  WELL: { address: "0xA88594D404727625A9437C3f886C7643872296AE", decimals: 18 },
  VIRTUAL: { address: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b", decimals: 18 },
  MORPHO: { address: "0x58D97B57BB95320F9a05dC918Aef65434969c2B2", decimals: 18 },
  MAMO: { address: "0x7300B37DfdfAb110d83290A29DfB31B1740219fE", decimals: 18 },
  VVV: { address: "0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf", decimals: 18 },
};

export function moonwellMTokenSymbol(symbol: string): string {
  const normalized = symbol.toUpperCase();
  if (normalized === "WETH") return "mETH";
  if (normalized === "USDBC") return "mUSDbC";
  if (normalized === "CBBTC") return "mcbBTC";
  if (normalized === "CBETH") return "mcbETH";
  if (normalized === "CBXRP") return "mcbXRP";
  return `m${normalized}`;
}

/** Map Moonwell mToken / market labels back to the underlying asset symbol. */
const MTOKEN_ALIAS_TO_UNDERLYING: Record<string, string> = {
  METH: "WETH",
  MUSDBC: "USDBC",
  MCBBTC: "CBBTC",
  MCBETH: "CBETH",
  MCBXRP: "CBXRP",
};

export function moonwellUnderlyingSymbol(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "?") return trimmed;

  const stripped = trimmed.replace(/^moonwell[_-\s]*/i, "").replace(/^mw(?=[A-Za-z])/i, "");
  const upper = stripped.toUpperCase();

  if (MOONWELL_MTOKENS[upper]) return upper;
  if (MTOKEN_ALIAS_TO_UNDERLYING[upper]) return MTOKEN_ALIAS_TO_UNDERLYING[upper];

  const mTokenMatch = upper.match(/^M([A-Z0-9]+)$/);
  if (mTokenMatch) {
    const suffix = mTokenMatch[1] ?? "";
    if (MOONWELL_MTOKENS[suffix]) return suffix;
    if (suffix === "ETH") return "WETH";
  }

  return upper;
}

export async function fetchMoonwellVaultSupplies(walletAddress: Address): Promise<MoonwellVaultSupply[]> {
  const publicClient = createPublicClient({
    chain: base,
    transport: http(resolveBaseRpcUrl()),
  });

  const entries = Object.entries(MOONWELL_VAULTS) as Array<[
    string,
    { address: Address; symbol: string; name: string },
  ]>;
  const rows: MoonwellVaultSupply[] = [];

  for (const [symbol, vault] of entries) {
    try {
      const [shares, shareDecimals] = await Promise.all([
        publicClient.readContract({
          address: vault.address,
          abi: MOONWELL_MTOKEN_ABI,
          functionName: "balanceOf",
          args: [walletAddress],
        }),
        publicClient.readContract({
          address: vault.address,
          abi: MOONWELL_MTOKEN_ABI,
          functionName: "decimals",
        }),
      ]);
      if (shares <= 0n) continue;

      const assets = await publicClient.readContract({
        address: vault.address,
        abi: MOONWELL_MTOKEN_ABI,
        functionName: "convertToAssets",
        args: [shares],
      });
      const underlying = MOONWELL_UNDERLYING_TOKENS[symbol];
      const underlyingDecimals = underlying?.decimals ?? 18;
      const underlyingAmount = Number(formatUnits(assets, underlyingDecimals));
      if (!Number.isFinite(underlyingAmount) || underlyingAmount <= 0) continue;

      rows.push({
        symbol,
        vaultSymbol: vault.symbol,
        vaultName: vault.name,
        vaultAddress: vault.address,
        shareBalance: Number(formatUnits(shares, Number(shareDecimals))),
        underlyingAmount,
      });
    } catch (err) {
      console.warn("⚠️ moonwell vault read failed", { symbol, vault: vault.address, err });
    }
  }

  return rows;
}

export async function fetchMoonwellDirectSupplies(walletAddress: Address): Promise<MoonwellDirectSupply[]> {
  const publicClient = createPublicClient({
    chain: base,
    transport: http(resolveBaseRpcUrl()),
  });

  const entries = Object.entries(MOONWELL_MTOKENS) as Array<[string, Address]>;
  const rows: MoonwellDirectSupply[] = [];
  const CHUNK_SIZE = 4;

  for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
    const chunk = entries.slice(i, i + CHUNK_SIZE);
    const chunkRows = await Promise.all(
      chunk.map(async ([symbol, mToken]) => {
        try {
          const [balance, mTokenDecimals] = await Promise.all([
            publicClient.readContract({
              address: mToken,
              abi: MOONWELL_MTOKEN_ABI,
              functionName: "balanceOf",
              args: [walletAddress],
            }),
            publicClient.readContract({
              address: mToken,
              abi: MOONWELL_MTOKEN_ABI,
              functionName: "decimals",
            }),
          ]);

          if (balance <= 0n) return null;

          const decimals = Number(mTokenDecimals);
          const exchangeRate = await publicClient
            .readContract({
              address: mToken,
              abi: MOONWELL_MTOKEN_ABI,
              functionName: "exchangeRateStored",
            })
            .catch(() => null);

          const underlyingDecimals = MOONWELL_UNDERLYING_TOKENS[symbol]?.decimals ?? 18;
          const underlyingRaw =
            typeof exchangeRate === "bigint" && exchangeRate > 0n
              ? (balance * exchangeRate) / (10n ** 18n)
              : null;

          return {
            symbol,
            mTokenSymbol: moonwellMTokenSymbol(symbol),
            mTokenBalance: Number(formatUnits(balance, decimals)),
            underlyingAmount: underlyingRaw != null ? Number(formatUnits(underlyingRaw, underlyingDecimals)) : null,
          };
        } catch (err) {
          console.warn("⚠️ moonwell direct mToken read failed", { symbol, mToken, err });
          return null;
        }
      }),
    );

    rows.push(...chunkRows.filter((row): row is MoonwellDirectSupply => row != null));
  }

  return rows;
}
