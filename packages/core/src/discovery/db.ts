import "@/load-env.js";

import { Pool, type PoolConfig } from "pg";

const DATABASE_URL = process.env.SHARED_GROUPS_DATABASE_URL || process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL or SHARED_GROUPS_DATABASE_URL is required");
const VECTOR_DATABASE_URL = process.env.VECTOR_DATABASE_URL?.trim();

const isProduction = process.env.NODE_ENV === "production";

const SSL_DISABLED_VALUES = new Set(["0", "false", "disable", "disabled", "no", "off"]);
const SSL_ENABLED_VALUES = new Set(["1", "true", "enable", "enabled", "require", "yes", "on"]);

function getConnectionUrl(connectionString: string): URL | undefined {
  try {
    return new URL(connectionString);
  } catch {
    return undefined;
  }
}

function getSslMode(connectionString: string): string | undefined {
  return getConnectionUrl(connectionString)?.searchParams.get("sslmode")?.trim().toLowerCase();
}

/** Railway private networking Postgres has no TLS — SSL handshake → ECONNRESET. */
function isRailwayPrivateHost(connectionString: string): boolean {
  const host = getConnectionUrl(connectionString)?.hostname.toLowerCase() ?? "";
  return host.endsWith(".railway.internal") || host.endsWith(".railway.local");
}

function resolvePgSsl(connectionString: string, sslOverride?: string): PoolConfig["ssl"] | undefined {
  const explicit = sslOverride?.trim().toLowerCase();
  if (explicit) {
    if (SSL_DISABLED_VALUES.has(explicit)) return false;
    if (SSL_ENABLED_VALUES.has(explicit)) return { rejectUnauthorized: false };
  }

  const sslMode = getSslMode(connectionString);
  if (sslMode === "disable") return false;
  if (sslMode === "require" || sslMode === "no-verify") return { rejectUnauthorized: false };

  // Prefer private-network defaults over NODE_ENV=production SSL.
  if (isRailwayPrivateHost(connectionString)) return false;

  return isProduction ? { rejectUnauthorized: false } : false;
}

function createPool(connectionString: string, sslOverride?: string): Pool {
  return new Pool({
    connectionString,
    ssl: resolvePgSsl(connectionString, sslOverride),
  });
}

export const db = createPool(
  DATABASE_URL,
  process.env.SHARED_GROUPS_DATABASE_SSL || process.env.DATABASE_SSL,
);

export const vectorDb = VECTOR_DATABASE_URL
  ? createPool(VECTOR_DATABASE_URL, process.env.VECTOR_DATABASE_SSL)
  : null;

function sslDebugLabel(connectionString: string, sslOverride?: string): string {
  const ssl = resolvePgSsl(connectionString, sslOverride);
  const host = getConnectionUrl(connectionString)?.hostname ?? "(invalid-url)";
  if (ssl === false) return `host=${host} ssl=off`;
  if (ssl && typeof ssl === "object") return `host=${host} ssl=on(rejectUnauthorized=${ssl.rejectUnauthorized !== false})`;
  return `host=${host} ssl=default`;
}

export async function connectDb(maxAttempts = 15): Promise<void> {
  const sslOverride = process.env.SHARED_GROUPS_DATABASE_SSL || process.env.DATABASE_SSL;
  console.log(`PostgreSQL connecting (${sslDebugLabel(DATABASE_URL || "", sslOverride)})`);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const client = await db.connect();
      client.release();
      console.log("✅ Connected to PostgreSQL");
      return;
    } catch (err) {
      lastErr = err;
      const delayMs = Math.min(30_000, 1500 * attempt);
      console.warn(
        `PostgreSQL connect attempt ${attempt}/${maxAttempts} failed — retry in ${delayMs}ms`,
      );
      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  const code =
    lastErr && typeof lastErr === "object" && "code" in lastErr
      ? String((lastErr as { code?: unknown }).code)
      : "";
  if (code === "ECONNRESET" || /terminated unexpectedly/i.test(String(lastErr))) {
    console.error(
      "PostgreSQL connection reset — if DATABASE_URL is Railway private (*.railway.internal), " +
        "set DATABASE_SSL=false (and VECTOR_DATABASE_SSL=false) or append ?sslmode=disable. " +
        "Public proxy URLs (*.proxy.rlwy.net) need SSL left on.",
    );
  }
  throw lastErr;
}
