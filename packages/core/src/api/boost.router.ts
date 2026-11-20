import { Router, type Request, type Response } from "express";
import {
  encodeFunctionData,
  parseUnits,
  type Address,
} from "viem";

import { NSGroupAdapter } from "@/discovery/adapters/nsGroup.adapter.js";
import { ActivityAdapter } from "@/discovery/adapters/activity.adapter.js";
import { GroupMemberSnapshotAdapter } from "@/discovery/adapters/groupMemberSnapshot.adapter.js";
import { logger } from "@/utils/logger.js";

const router = Router();

// USDC on Base mainnet
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const BOOST_PRICE_USDC = 5; // $5/week
const BOOST_PRICE_RAW = parseUnits(String(BOOST_PRICE_USDC), 6); // 5_000_000n

// Minimal ERC-20 transfer ABI
const ERC20_TRANSFER_ABI = [
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

// Treasury wallet — override with env var
const TREASURY = (process.env.BOOST_TREASURY_ADDRESS ||
  "0x0000000000000000000000000000000000000000") as Address;

// ─────────────────────────────────────────────
// GET /api/groups/trending
// Returns up to 20 suggestable groups ordered by:
//   1. paid_discovery (boosted) first
//   2. 6-hour activity score descending
// ─────────────────────────────────────────────
router.get("/api/groups/trending", async (_req: Request, res: Response) => {
  try {
    const [groups, activityMap] = await Promise.all([
      NSGroupAdapter.getSuggestableGroupsWithOwner(),
      ActivityAdapter.getAll6HourActivity(),
    ]);

    const scored = groups.map((g) => {
      const activity = activityMap.get(g.group_id) ?? [];
      const activityScore = activity.reduce(
        (sum, h) => sum + (h.message_count ?? 0) + (h.member_joins ?? 0),
        0,
      );
      return {
        groupId: g.group_id,
        name: g.name,
        description: g.description ?? null,
        memberCount: g.total_members ?? 0,
        inviteLink: g.invite_link ?? null,
        isBoosted: Boolean(g.paid_discovery),
        boostExpiresAt: g.paid_discovery_expires_at ?? null,
        activityScore,
      };
    });

    // Sort: boosted first, then by activity desc
    scored.sort((a, b) => {
      if (a.isBoosted !== b.isBoosted) return a.isBoosted ? -1 : 1;
      return b.activityScore - a.activityScore;
    });

    res.json({ groups: scored.slice(0, 20) });
  } catch (err: any) {
    logger.error({ err }, "GET /api/groups/trending");
    res.status(500).json({ error: err?.message || "Server error" });
  }
});

// ─────────────────────────────────────────────
// GET /api/groups/member-growth?days=2
// Accurate new-member growth across all groups Basemate is in, computed from
// daily member-count snapshots: delta = current_count - count_at_window_start.
// Returns the total plus a per-group breakdown (sorted by growth desc).
// ─────────────────────────────────────────────
router.get("/api/groups/member-growth", async (req: Request, res: Response) => {
  try {
    const daysRaw = Number((req.query as { days?: string }).days ?? 2);
    const days = Number.isFinite(daysRaw) ? Math.min(365, Math.max(1, Math.trunc(daysRaw))) : 2;

    const result = await GroupMemberSnapshotAdapter.getNewMembersSince(days);

    res.json({
      days: result.days,
      cutoffDate: result.cutoffDate,
      totalNewMembers: result.totalNewMembers, // gross joins (positive deltas)
      totalNetNewMembers: result.totalNetNewMembers, // net (joins - leaves)
      totalLostMembers: result.totalLostMembers, // gross leaves
      groupsTracked: result.groupsTracked,
      groups: result.groups.map((g) => ({
        groupId: g.group_id,
        name: g.name,
        baselineCount: g.baseline_count,
        currentCount: g.current_count,
        newMembers: g.delta,
        baselineDate: g.baseline_date,
        latestDate: g.latest_date,
      })),
    });
  } catch (err: any) {
    logger.error({ err }, "GET /api/groups/member-growth");
    res.status(500).json({ error: err?.message || "Server error" });
  }
});

// ─────────────────────────────────────────────
// GET /api/boost/prepare?groupId=<id>
// Returns an unsigned USDC transfer call so the
// client can sign + send it (wagmi sendTransaction).
// ─────────────────────────────────────────────
router.get("/api/boost/prepare", async (req: Request, res: Response) => {
  try {
    const { groupId } = req.query as { groupId?: string };
    if (!groupId) {
      res.status(400).json({ error: "groupId is required" });
      return;
    }

    if (TREASURY === "0x0000000000000000000000000000000000000000") {
      res.status(503).json({ error: "BOOST_TREASURY_ADDRESS not configured" });
      return;
    }

    const calldata = encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: "transfer",
      args: [TREASURY, BOOST_PRICE_RAW],
    });

    res.json({
      to: USDC_ADDRESS,
      data: calldata,
      value: "0x0",
      chainId: 8453, // Base mainnet
      label: `Boost "${groupId}" — $${BOOST_PRICE_USDC} USDC / week`,
      groupId,
      priceUsdc: BOOST_PRICE_USDC,
      treasury: TREASURY,
    });
  } catch (err: any) {
    logger.error({ err }, "GET /api/boost/prepare");
    res.status(500).json({ error: err?.message || "Server error" });
  }
});

// ─────────────────────────────────────────────
// POST /api/boost/activate
// Body: { groupId, txHash, payerAddress }
// Verifies the tx hash hasn't been used, records
// the payment, then activates the boost.
// ─────────────────────────────────────────────
router.post("/api/boost/activate", async (req: Request, res: Response) => {
  try {
    const { groupId, txHash, payerAddress } = req.body ?? {};

    if (!groupId || !txHash || !payerAddress) {
      res.status(400).json({ error: "groupId, txHash, and payerAddress are required" });
      return;
    }

    const normalizedHash = String(txHash).toLowerCase();
    const normalizedPayer = String(payerAddress).toLowerCase();

    // Idempotency — reject replay
    const alreadyUsed = await NSGroupAdapter.isTxHashUsed(normalizedHash);
    if (alreadyUsed) {
      res.status(409).json({ error: "Transaction already used for a boost" });
      return;
    }

    // Record payment + activate
    await NSGroupAdapter.recordBoostPayment(
      normalizedHash,
      String(groupId),
      normalizedPayer,
      BOOST_PRICE_USDC,
    );

    const { expiresAt } = await NSGroupAdapter.activateBoost(String(groupId));

    logger.info({ groupId, txHash: normalizedHash, payerAddress: normalizedPayer }, "Boost activated");

    res.json({
      ok: true,
      groupId,
      boostedUntil: expiresAt.toISOString(),
      priceUsdc: BOOST_PRICE_USDC,
    });
  } catch (err: any) {
    logger.error({ err }, "POST /api/boost/activate");
    res.status(500).json({ error: err?.message || "Server error" });
  }
});

// ─────────────────────────────────────────────
// GET /api/boost/status?groupId=<id>
// Lightweight check for a group's boost state
// ─────────────────────────────────────────────
router.get("/api/boost/status", async (req: Request, res: Response) => {
  try {
    const { groupId } = req.query as { groupId?: string };
    if (!groupId) {
      res.status(400).json({ error: "groupId is required" });
      return;
    }

    const status = await NSGroupAdapter.getBoostStatus(String(groupId));
    res.json({
      groupId,
      isBoosted: status.paidDiscovery,
      expiresAt: status.expiresAt?.toISOString() ?? null,
      boostScore: status.boostScore,
    });
  } catch (err: any) {
    logger.error({ err }, "GET /api/boost/status");
    res.status(500).json({ error: err?.message || "Server error" });
  }
});

export function mountBoostApi(app: import("express").Express): void {
  app.use(router);
}
