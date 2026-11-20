import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readContract: vi.fn(),
  getUserPositions: vi.fn(),
}));

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      readContract: mocks.readContract,
    })),
    http: vi.fn(() => ({})),
  };
});

vi.mock("@moonwell-fi/moonwell-sdk", () => ({
  createMoonwellClient: vi.fn(() => ({
    getUserPositions: mocks.getUserPositions,
  })),
}));

vi.mock("@basemate/avantis-client", () => ({
  AVANTIS_ENABLED: false,
  enrichAvantisPositionsWithPnl: vi.fn(),
  fetchAvantisUserData: vi.fn(),
}));

import {
  fetchMoonwellStaking,
  fetchMorphoUserStaking,
  fetchMorphoVaults,
} from "./service.js";
import {
  fetchMoonwellDirectSupplies,
  fetchMoonwellVaultSupplies,
  MOONWELL_MTOKENS,
  MOONWELL_VAULTS,
  moonwellMTokenSymbol,
  moonwellUnderlyingSymbol,
} from "./moonwell.js";

const WALLET = "0x0000000000000000000000000000000000000001";

beforeEach(() => {
  mocks.readContract.mockReset();
  mocks.getUserPositions.mockReset();
  mocks.getUserPositions.mockResolvedValue([]);
});

function mockUsdcDirectSupply(): void {
  mocks.readContract.mockImplementation(({ address, functionName }) => {
    if (functionName === "balanceOf") {
      return Promise.resolve(
        address.toLowerCase() === MOONWELL_MTOKENS.USDC.toLowerCase()
          ? 400_000_000n
          : 0n,
      );
    }
    if (functionName === "decimals") return Promise.resolve(8);
    if (functionName === "exchangeRateStored") return Promise.resolve(10_000_000_000_000_000n);
    throw new Error(`unexpected function ${String(functionName)}`);
  });
}

function mockMoonwellVaultSupply(): void {
  mocks.readContract.mockImplementation(({ address, functionName }) => {
    if (functionName === "balanceOf") {
      return Promise.resolve(
        address.toLowerCase() === MOONWELL_VAULTS.USDC.address.toLowerCase()
          ? 2_000_000_000_000_000_000n
          : 0n,
      );
    }
    if (functionName === "decimals") return Promise.resolve(18);
    if (functionName === "convertToAssets") return Promise.resolve(100_000_000n);
    throw new Error(`unexpected function ${String(functionName)}`);
  });
}

describe("Moonwell portfolio reads", () => {
  it("formats mToken symbols for Moonwell markets", () => {
    expect(moonwellMTokenSymbol("USDC")).toBe("mUSDC");
    expect(moonwellMTokenSymbol("WETH")).toBe("mETH");
  });

  it("maps mToken labels back to underlying assets", () => {
    expect(moonwellUnderlyingSymbol("mUSDC")).toBe("USDC");
    expect(moonwellUnderlyingSymbol("MUSDC")).toBe("USDC");
    expect(moonwellUnderlyingSymbol("mETH")).toBe("WETH");
    expect(moonwellUnderlyingSymbol("USDC")).toBe("USDC");
  });

  it("converts mUSDC balance into underlying USDC", async () => {
    mockUsdcDirectSupply();

    const supplies = await fetchMoonwellDirectSupplies(WALLET);

    expect(supplies).toContainEqual({
      symbol: "USDC",
      mTokenSymbol: "mUSDC",
      mTokenBalance: 4,
      underlyingAmount: 4,
    });
  });

  it("does not duplicate mUSDC SDK positions as a separate MUSDC market row", async () => {
    mocks.getUserPositions.mockResolvedValue([
      {
        suppliedUsd: 25,
        supplied: { formatted: 25, decimals: 6 },
        netSupplyApy: 0.042,
        market: { symbol: "mUSDC" },
      },
    ]);
    mockUsdcDirectSupply();

    const positions = await fetchMoonwellStaking(WALLET);

    expect(positions.filter((row) => row.protocol === "moonwell" && !row.id.includes(":moonwell-vault:"))).toEqual([
      expect.objectContaining({
        asset: "USDC",
        name: "Moonwell USDC",
        valueUsd: 25,
      }),
    ]);
  });

  it("emits a Moonwell staking row when SDK positions are empty but mUSDC exists", async () => {
    mockUsdcDirectSupply();

    const positions = await fetchMoonwellStaking(WALLET);

    expect(positions).toContainEqual(
      expect.objectContaining({
        protocol: "moonwell",
        asset: "USDC",
        name: "Moonwell USDC",
        amount: 4,
        decimals: 6,
        valueUsd: 4,
      }),
    );
  });

  it("reads Moonwell ERC-4626 vault balances as underlying assets", async () => {
    mockMoonwellVaultSupply();

    const supplies = await fetchMoonwellVaultSupplies(WALLET);

    expect(supplies).toContainEqual({
      symbol: "USDC",
      vaultSymbol: "mwUSDC",
      vaultName: "Moonwell Flagship USDC",
      vaultAddress: MOONWELL_VAULTS.USDC.address,
      shareBalance: 2,
      underlyingAmount: 100,
    });
  });

  it("emits Moonwell vault staking rows from ERC-4626 shares", async () => {
    mockMoonwellVaultSupply();

    const positions = await fetchMoonwellStaking(WALLET);

    expect(positions).toContainEqual(
      expect.objectContaining({
        protocol: "moonwell",
        asset: "USDC",
        name: "Moonwell Flagship USDC",
        amount: 100,
        decimals: 6,
        valueUsd: 100,
        healthFactor: null,
      }),
    );
  });
});

describe("Morpho portfolio reads", () => {
  it("reads MXNB vault positions from Morpho userByAddress", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          userByAddress: {
            vaultV2Positions: [
              {
                assets: "123450000",
                assetsUsd: 7.25,
                vault: {
                  address: "0x00000000000000000000000000000000000000ab",
                  name: "Juno MXNB Prime",
                  symbol: "jMXNB",
                  avgNetApy: 0.12,
                  asset: {
                    symbol: "MXNB",
                    decimals: 6,
                    address: "0xf197ffc28c23e0309b5559e7a166f2c6164c80aa",
                  },
                },
              },
            ],
            vaultPositions: [],
          },
        },
      }),
    } as Response);

    const positions = await fetchMorphoUserStaking(WALLET);
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      query: string;
      variables: { address: string; chainId: number };
    };

    expect(requestBody.query).toContain("userByAddress");
    expect(requestBody.variables).toEqual({ address: WALLET, chainId: 8453 });
    expect(positions).toContainEqual({
      id: `${WALLET}:morpho:0x00000000000000000000000000000000000000ab`,
      walletAddress: WALLET,
      protocol: "morpho",
      asset: "MXNB",
      name: "Juno MXNB Prime",
      amount: 123.45,
      decimals: 6,
      valueUsd: 7.25,
      apy: 12,
      healthFactor: null,
    });

    fetchMock.mockRestore();
  });

  it("formats numeric Morpho asset balances with vault decimals", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          userByAddress: {
            vaultV2Positions: [
              {
                assets: 16_000_000,
                assetsUsd: 16,
                vault: {
                  address: "0x00000000000000000000000000000000000000ab",
                  name: "Juno MXNB Prime",
                  symbol: "jMXNB",
                  avgNetApy: 0.12,
                  asset: {
                    symbol: "MXNB",
                    decimals: 6,
                    address: "0xf197ffc28c23e0309b5559e7a166f2c6164c80aa",
                  },
                },
              },
            ],
            vaultPositions: [],
          },
        },
      }),
    } as Response);

    const positions = await fetchMorphoUserStaking(WALLET);

    expect(positions).toContainEqual(
      expect.objectContaining({
        asset: "MXNB",
        amount: 16,
        decimals: 6,
      }),
    );

    fetchMock.mockRestore();
  });

  it("does not duplicate Moonwell vault shares as generic Morpho positions", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          userByAddress: {
            vaultV2Positions: [
              {
                assets: "100000000",
                assetsUsd: 100,
                vault: {
                  address: MOONWELL_VAULTS.USDC.address,
                  name: "Moonwell Flagship USDC",
                  symbol: "mwUSDC",
                  avgNetApy: 0.05,
                  asset: {
                    symbol: "USDC",
                    decimals: 6,
                    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                  },
                },
              },
            ],
            vaultPositions: [],
          },
        },
      }),
    } as Response);

    await expect(fetchMorphoUserStaking(WALLET)).resolves.toEqual([]);

    fetchMock.mockRestore();
  });

  it("requests enough V2 vaults to include MXNB vaults", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          vaults: { items: [] },
          vaultV2s: {
            items: [
              {
                address: "0x00000000000000000000000000000000000000ab",
                name: "Juno MXNB Prime",
                asset: {
                  symbol: "MXNB",
                  decimals: 6,
                  address: "0xf197ffc28c23e0309b5559e7a166f2c6164c80aa",
                },
                netApy: 0.12,
              },
            ],
          },
        },
      }),
    } as Response);

    const vaults = await fetchMorphoVaults();
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { query: string };

    expect(requestBody.query).toContain("vaultV2s(first: 100");
    expect(vaults).toContainEqual({
      address: "0x00000000000000000000000000000000000000ab",
      name: "Juno MXNB Prime",
      assetSymbol: "MXNB",
      assetDecimals: 6,
      assetAddress: "0xf197ffc28c23e0309b5559e7a166f2c6164c80aa",
      apy: 12,
    });

    fetchMock.mockRestore();
  });
});
