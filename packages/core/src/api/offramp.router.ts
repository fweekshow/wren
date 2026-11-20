import { Router, type Request, type Response } from "express";

import { config } from "@/config/config.js";
import {
  createOfframpApproval,
  launchOfframp,
  OfframpValidationError,
  refreshOfframp,
  requireCapability,
  toPublicOfframpStatus,
} from "@/wallet/offramp.js";
import { logger } from "@/utils/logger.js";

const router = Router();
const CAPABILITY_RE = /^[A-Za-z0-9_-]{32}$/;
const OFFRAMP_PATH = "/api/agent/offramp";
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 30;
const requestWindows = new Map<string, { count: number; resetAt: number }>();

// Scoped to the offramp's own paths: unscoped, this ran on every request
// through the router and rate-limited unrelated routes (all of /api/app).
router.use(OFFRAMP_PATH, (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  const origin = req.headers.origin;
  if (origin && origin !== config.cdp.payPageOrigin) {
    res.status(403).json({ error: "Origin not allowed" });
    return;
  }
  if (origin === config.cdp.payPageOrigin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  next();
});

router.use(OFFRAMP_PATH, (req, res, next) => {
  const token = readToken(req);
  const key = token || req.ip || "unknown";
  const now = Date.now();
  const current = requestWindows.get(key);
  if (!current || current.resetAt <= now) {
    requestWindows.set(key, { count: 1, resetAt: now + WINDOW_MS });
    next();
    return;
  }
  current.count += 1;
  if (current.count > MAX_REQUESTS) {
    res.status(429).json({ error: "Too many requests" });
    return;
  }
  next();
});

router.get("/api/agent/offramp", async (req, res) => {
  try {
    const token = requireToken(req);
    const session = await requireCapability(token);
    res.json(toPublicOfframpStatus(session));
  } catch (error) {
    handleError(error, res, "GET /api/agent/offramp");
  }
});

router.post("/api/agent/offramp/launch", async (req, res) => {
  try {
    const token = requireToken(req);
    const result = await launchOfframp(token, req.get("x-basemate-client-ip")?.trim());
    res.json({
      coinbaseUrl: result.coinbaseUrl,
      session: toPublicOfframpStatus(result.session),
    });
  } catch (error) {
    handleError(error, res, "POST /api/agent/offramp/launch");
  }
});

router.post("/api/agent/offramp/refresh", async (req, res) => {
  try {
    const token = requireToken(req);
    const session = await refreshOfframp(token);
    res.json(toPublicOfframpStatus(session));
  } catch (error) {
    handleError(error, res, "POST /api/agent/offramp/refresh");
  }
});

router.post("/api/agent/offramp/approval", async (req, res) => {
  try {
    const token = requireToken(req);
    const result = await createOfframpApproval(token);
    res.json({
      approvalUrl: result.approvalUrl,
      session: toPublicOfframpStatus(result.session),
    });
  } catch (error) {
    handleError(error, res, "POST /api/agent/offramp/approval");
  }
});

function readToken(req: Request): string {
  const query = typeof req.query.token === "string" ? req.query.token : "";
  const body =
    req.body && typeof req.body === "object" && typeof req.body.token === "string"
      ? req.body.token
      : "";
  return (body || query).trim();
}

function requireToken(req: Request): string {
  const token = readToken(req);
  if (!CAPABILITY_RE.test(token)) {
    throw new OfframpValidationError("Missing or invalid cash-out token.");
  }
  return token;
}

function handleError(error: unknown, res: Response, route: string): void {
  if (error instanceof OfframpValidationError) {
    res.status(400).json({ error: error.message });
    return;
  }
  logger.error({ err: error }, route);
  res.status(500).json({ error: "Cash-out service unavailable." });
}

export function mountOfframpApi(app: import("express").Express): void {
  app.use(router);
}
