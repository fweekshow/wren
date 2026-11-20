import pino from "pino";
import { pinoHttp } from "pino-http";

import { config } from "@/config/config.js";

const isProd = config.env === "production";
const level = process.env.LOG_LEVEL?.toLowerCase() ?? "info";

const redactPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  "password",
  "token",
  "secret",
  "key",
  "jwt",
  "apiKey",
  "api_key",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "privateKey",
  "private_key",
  "walletKey",
  "wallet_key",
];

export const logger = pino({
  level,

  redact: {
    paths: redactPaths,
    remove: true,
  },

  transport: isProd
    ? undefined
    : {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
        },
      },
});

/**
 * pino-http middleware for Express.
 * Skips logging for /health and /ready so they don't flood logs.
 */
export const httpLogger = pinoHttp({
  logger,
  customSuccessMessage: (req, res) =>
    `${req.method} ${req.url} → ${res.statusCode}`,
  autoLogging: {
    ignore: (req) => req.url === "/health" || req.url === "/ready",
  },
});
