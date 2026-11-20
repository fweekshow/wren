import { timingSafeEqual } from "node:crypto";

import { config } from "@/config/config.js";

export function bearerToken(header: string | undefined): string {
  const raw = header?.trim() ?? "";
  if (raw.toLowerCase().startsWith("bearer ")) return raw.slice(7).trim();
  return raw;
}

export function museKeyValid(presented: string): boolean {
  const keys = config.muse.apiKeys;
  if (!presented || keys.length === 0) return false;
  const a = Buffer.from(presented);
  return keys.some((key) => {
    const b = Buffer.from(key);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

export function assertMuseApiKeys(): void {
  if (config.muse.apiKeys.length === 0) {
    throw new Error("MUSE_API_KEY is not set");
  }
}
