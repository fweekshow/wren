import dns, { setDefaultResultOrder } from "node:dns";
import { promisify } from "node:util";

/**
 * Railway public egress on this service is IPv4-only (`ipv6EgressEnabled: false`).
 * Photon/gRPC still resolves Cloudflare AAAA first, then SendTextMessage dies with
 * UNAVAILABLE / "No connection established".
 *
 * Do not pin family 4 for Railway private DNS — legacy environments are IPv6-only
 * on `*.railway.internal`.
 */
export function shouldForceIpv4Lookup(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host) return false;
  if (
    host.endsWith(".railway.internal") ||
    host.endsWith(".railway.local") ||
    host.endsWith(".internal")
  ) {
    return false;
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return false;
  return true;
}

let applied = false;

export function applyPreferIpv4Dns(): void {
  if (applied) return;
  applied = true;

  setDefaultResultOrder("ipv4first");

  const originalLookup = dns.lookup.bind(dns);
  const lookupPreferIpv4: typeof dns.lookup = ((
    hostname: string,
    options?: unknown,
    callback?: unknown,
  ) => {
    if (!shouldForceIpv4Lookup(hostname)) {
      return originalLookup(
        hostname,
        options as Parameters<typeof dns.lookup>[1],
        callback as Parameters<typeof dns.lookup>[2],
      );
    }
    if (typeof options === "function") {
      return originalLookup(hostname, { family: 4 }, options as Parameters<typeof dns.lookup>[2]);
    }
    const opts =
      options && typeof options === "object"
        ? { ...(options as object), family: 4 }
        : { family: 4 };
    return originalLookup(
      hostname,
      opts as Parameters<typeof dns.lookup>[1],
      callback as Parameters<typeof dns.lookup>[2],
    );
  }) as typeof dns.lookup;

  dns.lookup = lookupPreferIpv4;
  dns.promises.lookup = promisify(lookupPreferIpv4) as typeof dns.promises.lookup;
}
