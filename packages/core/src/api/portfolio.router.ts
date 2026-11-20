import { Router, type Request, type Response } from "express";

import { verifyPortfolioAccessToken } from "@/portfolio/access.js";
import { buildPortfolioForUser } from "@/portfolio/service.js";
import { logger } from "@/utils/logger.js";

const router = Router();

router.get("/api/agent/portfolio", async (req: Request, res: Response) => {
  const user = typeof req.query.user === "string" ? req.query.user : "";
  const token = typeof req.query.token === "string" ? req.query.token : "";

  if (!user || !token) {
    res.status(400).json({ error: "Missing user or token" });
    return;
  }

  try {
    const verified = verifyPortfolioAccessToken(user, token);
    if (!verified.ok) {
      res.status(401).json({ error: "Invalid portfolio link", reason: verified.reason });
      return;
    }

    const portfolio = await buildPortfolioForUser(user);
    if (!portfolio) {
      res.status(404).json({ error: "Portfolio user not found" });
      return;
    }

    res.setHeader("Cache-Control", "no-store");
    res.json(portfolio);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Server error";
    logger.error({ err }, "GET /api/agent/portfolio");
    res.status(500).json({ error: message });
  }
});

export function mountPortfolioApi(app: import("express").Express): void {
  app.use(router);
}
