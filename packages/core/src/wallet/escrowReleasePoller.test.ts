import { beforeEach, describe, expect, it, vi } from "vitest";

// Keep the import graph off real config/db — we override every dep anyway.
vi.mock("@/config/config.js", () => ({
  config: { phoneEscrow: { releaseEnabled: true } },
}));
vi.mock("@/utils/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/discovery/db.js", () => ({ db: { query: vi.fn(), connect: vi.fn() } }));
vi.mock("@/discovery/adapters/wallet.adapter.js", () => ({ WalletAdapter: {} }));
vi.mock("./phoneEscrow.js", () => ({ PhoneEscrowAdapter: {} }));

import { EscrowReleasePoller } from "./escrowReleasePoller.js";
import type {
  PhoneEscrowPosition,
  PhoneEscrowReleaseResult,
} from "./phoneEscrow.js";

const PHONE = "+917003993121";
const ADDRESS = "0x1111111111111111111111111111111111111111";
const POSITION: PhoneEscrowPosition = {
  phone: PHONE,
  tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  tokenSymbol: "USDC",
  tokenDecimals: 6,
};

function releaseResult(): PhoneEscrowReleaseResult {
  return {
    phone: PHONE,
    phoneHash: "0x8b7b",
    tokenAddress: POSITION.tokenAddress,
    tokenSymbol: POSITION.tokenSymbol,
    tokenDecimals: POSITION.tokenDecimals,
    amount: "0.1",
    amountAtomic: 100000n,
    transactionHash: "0xdeadbeef",
  };
}

function makePoller(opts: {
  positions?: PhoneEscrowPosition[];
  address?: string | null;
  claimWon?: boolean;
  release?: PhoneEscrowReleaseResult | null | (() => never);
}) {
  const release = vi.fn(async () => {
    if (typeof opts.release === "function") opts.release();
    return opts.release === undefined ? releaseResult() : (opts.release as PhoneEscrowReleaseResult | null);
  });
  const deliver = vi.fn(async () => true);
  const claim = vi.fn(async () => opts.claimWon ?? true);
  const unclaim = vi.fn(async () => {});
  const getConnectedAddress = vi.fn(async () =>
    opts.address === undefined ? ADDRESS : opts.address,
  );
  const poller = new EscrowReleasePoller({
    listPositions: async () => opts.positions ?? [POSITION],
    getConnectedAddress,
    claim,
    unclaim,
    release,
    deliver,
  });
  return { poller, release, deliver, claim, unclaim, getConnectedAddress };
}

describe("EscrowReleasePoller", () => {
  beforeEach(() => vi.clearAllMocks());

  it("releases to a connected recipient and DMs them", async () => {
    const { poller, claim, release, deliver, unclaim } = makePoller({});
    const res = await poller.tickOnce();
    expect(res).toMatchObject({ checked: 1, released: 1, delivered: 1 });
    expect(claim).toHaveBeenCalledWith(POSITION);
    expect(release).toHaveBeenCalledWith(POSITION, ADDRESS);
    expect(deliver.mock.calls[0]?.[1]).toContain("0.1 USDC");
    expect(unclaim).not.toHaveBeenCalled();
  });

  it("skips a recipient with no connected Basemate wallet", async () => {
    const { poller, claim, release } = makePoller({ address: null });
    const res = await poller.tickOnce();
    expect(res).toMatchObject({ released: 0, delivered: 0 });
    expect(claim).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("does not release when it loses the claim lock", async () => {
    const { poller, release } = makePoller({ claimWon: false });
    const res = await poller.tickOnce();
    expect(res).toMatchObject({ released: 0 });
    expect(release).not.toHaveBeenCalled();
  });

  it("rolls the lock back when the contract has nothing to release", async () => {
    const { poller, unclaim, deliver } = makePoller({ release: null });
    const res = await poller.tickOnce();
    expect(res).toMatchObject({ released: 0, delivered: 0 });
    expect(unclaim).toHaveBeenCalledWith(POSITION);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("rolls the lock back and keeps going when release throws", async () => {
    const { poller, unclaim, deliver } = makePoller({
      release: () => {
        throw new Error("rpc down");
      },
    });
    const res = await poller.tickOnce();
    expect(res).toMatchObject({ released: 0 });
    expect(unclaim).toHaveBeenCalledWith(POSITION);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("releases multiple tokens for the same phone independently", async () => {
    const basemate: PhoneEscrowPosition = {
      phone: PHONE,
      tokenAddress: "0x07E61D8a4e197dfC269e90D7ECe1dF0D26702bA3",
      tokenSymbol: "BASEMATE",
      tokenDecimals: 18,
    };
    const release = vi.fn(async (position: PhoneEscrowPosition) => ({
      ...releaseResult(),
      tokenAddress: position.tokenAddress,
      tokenSymbol: position.tokenSymbol,
      tokenDecimals: position.tokenDecimals,
      amount: position.tokenSymbol === "BASEMATE" ? "10000" : "0.1",
    }));
    const deliver = vi.fn(async () => true);
    const poller = new EscrowReleasePoller({
      listPositions: async () => [POSITION, basemate],
      getConnectedAddress: async () => ADDRESS,
      claim: async () => true,
      unclaim: async () => {},
      release,
      deliver,
    });

    await expect(poller.tickOnce()).resolves.toMatchObject({
      checked: 2,
      released: 2,
      delivered: 2,
    });
    expect(release).toHaveBeenNthCalledWith(1, POSITION, ADDRESS);
    expect(release).toHaveBeenNthCalledWith(2, basemate, ADDRESS);
    expect(deliver.mock.calls[1]?.[1]).toContain("10000 BASEMATE");
  });
});
