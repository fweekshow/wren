import { describe, expect, it } from "vitest";

import { shouldForceIpv4Lookup } from "./preferIpv4Dns.js";

describe("shouldForceIpv4Lookup", () => {
  it("pins public Photon / Cloudflare hosts to IPv4", () => {
    expect(shouldForceIpv4Lookup("imessage.photon.codes")).toBe(true);
    expect(shouldForceIpv4Lookup("spectrum.photon.codes")).toBe(true);
  });

  it("leaves Railway private DNS alone", () => {
    expect(shouldForceIpv4Lookup("postgres.railway.internal")).toBe(false);
    expect(shouldForceIpv4Lookup("redis.railway.internal")).toBe(false);
  });
});
