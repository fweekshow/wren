import type {
  BankrLaunchSort,
  BankrLaunchesResult,
  DeployTokenArgs,
  LaunchResult,
} from "@basemate/shared";
import { fetchBankrLaunches } from "@basemate/shared";

const BACKEND_URL = (process.env.BANKR_BACKEND_URL ?? "").trim().replace(/\/$/, "");
const SERVICE_API_KEY = (process.env.SERVICE_API_KEY ?? "").trim();

/** Bankr is "enabled" for the bots when the backend URL is configured. */
export const BANKR_ENABLED = Boolean(BACKEND_URL);

class BankrBackendError extends Error {}

function isBackendUnreachable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  const code = (err as NodeJS.ErrnoException).code;
  return (
    code === "ConnectionRefused" ||
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    msg.includes("connection refused") ||
    msg.includes("unable to connect")
  );
}

async function requestBackend<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  timeoutMs = 35_000,
): Promise<T> {
  if (!BACKEND_URL) throw new BankrBackendError("BANKR_BACKEND_URL not configured");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (SERVICE_API_KEY) headers.Authorization = `Bearer ${SERVICE_API_KEY}`;

  const resp = await fetch(`${BACKEND_URL}${path}`, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new BankrBackendError(`bankr-backend ${path} -> ${resp.status}`);
  return (await resp.json()) as T;
}

export async function deployBankrToken(opts: DeployTokenArgs): Promise<LaunchResult> {
  try {
    return await requestBackend<LaunchResult>("POST", "/token-launches/deploy", opts);
  } catch (err) {
    console.warn("⚠️ bankr-client deployBankrToken error:", err);
    return { ok: false, error: String(err) };
  }
}

/**
 * Bankr ecosystem trending/new launches. Tries bankr-backend first; falls back to
 * direct `/discover` when the backend is down (common in local dev).
 */
export async function getBankrLaunches(
  limit = 8,
  sort: BankrLaunchSort = "mcap",
): Promise<BankrLaunchesResult> {
  if (BACKEND_URL) {
    try {
      return await requestBackend<BankrLaunchesResult>(
        "GET",
        `/launches?limit=${limit}&sort=${sort}`,
      );
    } catch (err) {
      if (!isBackendUnreachable(err)) throw err;
      // Backend unavailable — fall back silently to direct Bankr /discover
    }
  }

  return fetchBankrLaunches(limit, sort);
}

/** Fresh + trending movers for daily briefs. */
export async function getTrendingTokens(limit = 8): Promise<BankrLaunchesResult> {
  return getBankrLaunches(limit, "mixed");
}
