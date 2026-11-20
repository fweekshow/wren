import { Router } from "express";
import { verifyMessage } from "viem";

import { KeywordAdapter, type KeywordTargetType } from "@/discovery/adapters/keyword.adapter.js";
import { invalidateKeywordCache } from "@/shared/keyword-matcher.js";
import { embedText } from "@/shared/scorer/embedder.js";
import { logger } from "@/utils/logger.js";

const router = Router();

const AUTH_WINDOW_MS = 10 * 60 * 1000;

function parseAuthMessage(message: string): { action: string; ts: number } | null {
  const m = /^Basemate keywords:(\w+):(\d+)$/.exec(message.trim());
  if (!m) return null;
  const ts = Number(m[2]);
  if (!Number.isFinite(ts)) return null;
  return { action: m[1]!, ts };
}

async function assertSigned(
  ownerWallet: string,
  message: string,
  signature: `0x${string}`,
): Promise<{ ok: boolean; reason?: string }> {
  const parsed = parseAuthMessage(message);
  if (!parsed) return { ok: false, reason: "Invalid message format" };
  if (Math.abs(Date.now() - parsed.ts) > AUTH_WINDOW_MS) {
    return { ok: false, reason: "Message expired" };
  }
  try {
    const ok = await verifyMessage({
      address: ownerWallet as `0x${string}`,
      message,
      signature,
    });
    return { ok };
  } catch {
    return { ok: false, reason: "Invalid signature" };
  }
}

router.get("/api/keywords", async (_req, res) => {
  try {
    const rows = await KeywordAdapter.listMarketplace();
    res.json({ keywords: rows });
  } catch (err: any) {
    logger.error({ err }, "GET /api/keywords");
    res.status(500).json({ error: err?.message || "Server error" });
  }
});

router.post("/api/keywords/mine", async (req, res) => {
  try {
    const { ownerWallet, signature, message } = req.body ?? {};
    if (!ownerWallet || !signature || !message) {
      res.status(400).json({ error: "ownerWallet, signature, and message required" });
      return;
    }
    const auth = await assertSigned(ownerWallet, message, signature as `0x${string}`);
    if (!auth.ok) {
      res.status(401).json({ error: auth.reason || "Unauthorized" });
      return;
    }
    const parsed = parseAuthMessage(message);
    if (parsed?.action !== "list") {
      res.status(400).json({ error: "Message action must be list" });
      return;
    }
    const keywords = await KeywordAdapter.listByOwner(ownerWallet);
    res.json({ keywords });
  } catch (err: any) {
    logger.error({ err }, "POST /api/keywords/mine");
    res.status(500).json({ error: err?.message || "Server error" });
  }
});

router.post("/api/keywords", async (req, res) => {
  try {
    const {
      keyword,
      targetGroupId,
      targetGroupType,
      targetGroupName,
      targetInviteLink,
      bidUsdc,
      totalBudgetUsdc,
      ownerWallet,
      signature,
      message,
      paymentId,
    } = req.body ?? {};

    if (!keyword || !targetGroupId || !targetGroupType || !ownerWallet || !signature || !message) {
      res.status(400).json({ error: "Missing required fields" });
      return;
    }
    if (targetGroupType !== "telegram" && targetGroupType !== "base") {
      res.status(400).json({ error: "targetGroupType must be telegram or base" });
      return;
    }
    if (targetGroupType === "base" && !targetInviteLink) {
      res.status(400).json({ error: "targetInviteLink required for base targets" });
      return;
    }

    const auth = await assertSigned(ownerWallet, message, signature as `0x${string}`);
    if (!auth.ok) {
      res.status(401).json({ error: auth.reason || "Unauthorized" });
      return;
    }
    const parsed = parseAuthMessage(message);
    if (parsed?.action !== "register") {
      res.status(400).json({ error: "Message action must be register" });
      return;
    }

    const bid = Number(bidUsdc ?? 0);
    const budget = Number(totalBudgetUsdc ?? 0);
    if (!Number.isFinite(bid) || bid < 0 || !Number.isFinite(budget) || budget <= 0) {
      res.status(400).json({ error: "bidUsdc and totalBudgetUsdc must be valid numbers" });
      return;
    }

    let embedding: number[] | null = null;
    try {
      embedding = await embedText(String(keyword).trim().slice(0, 500));
    } catch {
      /* optional */
    }

    const id = await KeywordAdapter.insertKeyword({
      keyword: String(keyword),
      ownerWallet: String(ownerWallet),
      targetGroupId: String(targetGroupId),
      targetGroupType: targetGroupType as KeywordTargetType,
      targetGroupName: targetGroupName ? String(targetGroupName) : null,
      targetInviteLink: targetInviteLink ? String(targetInviteLink) : null,
      bidUsdc: bid,
      totalBudgetUsdc: budget,
      paymentId: paymentId ? String(paymentId) : null,
      embedding,
    });

    invalidateKeywordCache();
    res.status(201).json({ id });
  } catch (err: any) {
    logger.error({ err }, "POST /api/keywords");
    res.status(500).json({ error: err?.message || "Server error" });
  }
});

router.patch("/api/keywords/:id", async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id ?? "", 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const { ownerWallet, signature, message, status, bidUsdc, topUpUsdc, paymentId } =
      req.body ?? {};
    if (!ownerWallet || !signature || !message) {
      res.status(400).json({ error: "ownerWallet, signature, and message required" });
      return;
    }
    const auth = await assertSigned(ownerWallet, message, signature as `0x${string}`);
    if (!auth.ok) {
      res.status(401).json({ error: auth.reason || "Unauthorized" });
      return;
    }
    const parsed = parseAuthMessage(message);
    if (parsed?.action !== "update") {
      res.status(400).json({ error: "Message action must be update" });
      return;
    }

    if (status === "paused" || status === "active") {
      const ok = await KeywordAdapter.updateStatus(id, ownerWallet, status);
      if (!ok) {
        res.status(404).json({ error: "Keyword not found" });
        return;
      }
    }
    if (bidUsdc !== undefined) {
      const bid = Number(bidUsdc);
      if (!Number.isFinite(bid) || bid < 0) {
        res.status(400).json({ error: "Invalid bidUsdc" });
        return;
      }
      const ok = await KeywordAdapter.updateBid(id, ownerWallet, bid);
      if (!ok) {
        res.status(404).json({ error: "Keyword not found" });
        return;
      }
    }
    if (topUpUsdc !== undefined) {
      const amt = Number(topUpUsdc);
      if (!Number.isFinite(amt) || amt <= 0) {
        res.status(400).json({ error: "Invalid topUpUsdc" });
        return;
      }
      const ok = await KeywordAdapter.topUpBudget(id, ownerWallet, amt, paymentId ?? null);
      if (!ok) {
        res.status(404).json({ error: "Keyword not found" });
        return;
      }
    }

    invalidateKeywordCache();
    const row = await KeywordAdapter.getById(id);
    res.json({ keyword: row });
  } catch (err: any) {
    logger.error({ err }, "PATCH /api/keywords/:id");
    res.status(500).json({ error: err?.message || "Server error" });
  }
});

router.delete("/api/keywords/:id", async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id ?? "", 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const { ownerWallet, signature, message } = req.body ?? {};
    if (!ownerWallet || !signature || !message) {
      res.status(400).json({ error: "ownerWallet, signature, and message required" });
      return;
    }
    const auth = await assertSigned(ownerWallet, message, signature as `0x${string}`);
    if (!auth.ok) {
      res.status(401).json({ error: auth.reason || "Unauthorized" });
      return;
    }
    const parsed = parseAuthMessage(message);
    if (parsed?.action !== "delete") {
      res.status(400).json({ error: "Message action must be delete" });
      return;
    }
    const ok = await KeywordAdapter.updateStatus(id, ownerWallet, "paused");
    if (!ok) {
      res.status(404).json({ error: "Keyword not found" });
      return;
    }
    invalidateKeywordCache();
    res.json({ ok: true });
  } catch (err: any) {
    logger.error({ err }, "DELETE /api/keywords/:id");
    res.status(500).json({ error: err?.message || "Server error" });
  }
});

export function mountKeywordsApi(app: import("express").Express): void {
  app.use(router);
}
