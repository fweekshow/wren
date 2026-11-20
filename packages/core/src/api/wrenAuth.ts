import type { Request, Response } from "express";

import { verifyPortfolioAccessToken } from "@/portfolio/access.js";

export function authedSender(req: Request, res: Response): string | null {
  const user = typeof req.query.user === "string" ? req.query.user : req.body?.user;
  const token = typeof req.query.token === "string" ? req.query.token : req.body?.token;
  if (typeof user !== "string" || typeof token !== "string") {
    res.status(401).json({ error: "Sign in again." });
    return null;
  }
  const verified = verifyPortfolioAccessToken(user, token);
  if (!verified.ok) {
    res.status(401).json({ error: "Sign in again." });
    return null;
  }
  return user;
}
