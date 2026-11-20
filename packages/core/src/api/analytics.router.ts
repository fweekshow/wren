import { Router, type Request, type Response } from "express";

import { AgentAnalyticsAdapter } from "@/discovery/adapters/agentAnalytics.adapter.js";
import { logger } from "@/utils/logger.js";

const router = Router();

/**
 * GET /api/agent/analytics
 *
 * Aggregated metrics for the XMTP discovery agent from Postgres.
 * Optional query: ?instanceId=basemate (defaults to AGENT_INSTANCE_ID or "basemate")
 */
router.get("/api/agent/analytics", async (req: Request, res: Response) => {
  try {
    const instanceId =
      typeof req.query.instanceId === "string"
        ? req.query.instanceId
        : AgentAnalyticsAdapter.resolveInstanceId();

    const analytics = await AgentAnalyticsAdapter.getSummary(instanceId);
    res.json(analytics);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Server error";
    logger.error({ err }, "GET /api/agent/analytics");
    res.status(500).json({ error: message });
  }
});

export function mountAnalyticsApi(app: import("express").Express): void {
  app.use(router);
}
