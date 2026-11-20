import type { NextFunction, Request, Response } from "express";

const DEV_DEFAULT_ORIGINS = ["http://localhost:3000"];
const CORS_MAX_AGE_SECONDS = "600";

export function parseAllowedOrigins(env = process.env): Set<string> {
  const raw = env.CORS_ALLOWED_ORIGINS?.trim() || env.KEYWORDS_CORS_ORIGINS?.trim();
  const origins = raw
    ? raw
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean)
    : env.NODE_ENV === "production"
      ? []
      : DEV_DEFAULT_ORIGINS;

  const allow = new Set<string>();
  for (const origin of origins) {
    if (origin === "*" && env.NODE_ENV === "production") {
      console.warn("Ignoring wildcard CORS origin in production");
      continue;
    }
    allow.add(origin);
  }
  return allow;
}

export function createCorsMiddleware(allowedMethods: string[]) {
  const methods = allowedMethods.join(",");

  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    const allow = parseAllowedOrigins();
    const isAllowed = Boolean(origin && allow.has(origin));

    if (origin && isAllowed) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", methods);
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Idempotency-Key");
      res.setHeader("Access-Control-Max-Age", CORS_MAX_AGE_SECONDS);
    }

    if (req.method === "OPTIONS") {
      res.status(isAllowed ? 204 : 403).end();
      return;
    }

    next();
  };
}

export const browserApiCors = createCorsMiddleware(["GET", "POST", "PATCH", "DELETE", "OPTIONS"]);
