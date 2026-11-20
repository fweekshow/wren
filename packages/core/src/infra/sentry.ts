import * as Sentry from "@sentry/node";

import { config } from "@/config/config.js";

/**
 * Call once at the very top of each app's entry point.
 * No-ops gracefully when SENTRY_DSN is not set.
 */
export function initSentry(serviceName: string): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: config.env,
    serverName: serviceName,
    tracesSampleRate: config.env === "production" ? 0.1 : 0,
    integrations: [Sentry.onUncaughtExceptionIntegration(), Sentry.onUnhandledRejectionIntegration()],
  });
}

export { Sentry };
