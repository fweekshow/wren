import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isLaunchImageSkip, uploadLaunchImage } from "./launchImageUpload.js";

describe("isLaunchImageSkip", () => {
  it("recognizes skip phrases", () => {
    expect(isLaunchImageSkip("skip")).toBe(true);
    expect(isLaunchImageSkip("SKIP")).toBe(true);
    expect(isLaunchImageSkip("no")).toBe(true);
    expect(isLaunchImageSkip("none")).toBe(true);
  });

  it("rejects non-skip text", () => {
    expect(isLaunchImageSkip("yes")).toBe(false);
    expect(isLaunchImageSkip("photo")).toBe(false);
  });
});

describe("uploadLaunchImage", () => {
  const originalFetch = globalThis.fetch;
  const env = {
    CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME,
    CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY,
    CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET,
  };

  beforeEach(() => {
    process.env.CLOUDINARY_CLOUD_NAME = "testcloud";
    process.env.CLOUDINARY_API_KEY = "key123";
    process.env.CLOUDINARY_API_SECRET = "secret456";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.restoreAllMocks();
  });

  it("POSTs to Cloudinary with signature and returns secure_url", async () => {
    let requestUrl = "";
    let hasSignature = false;

    globalThis.fetch = vi.fn(async (url, init) => {
      requestUrl = String(url);
      const body = init?.body;
      if (body instanceof FormData) {
        hasSignature = body.has("signature") && body.has("api_key");
      }
      return new Response(
        JSON.stringify({
          secure_url:
            "https://res.cloudinary.com/testcloud/image/upload/v1/token-launches/abc.jpg",
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const url = await uploadLaunchImage(
      new Uint8Array([0xff, 0xd8, 0xff]),
      "logo.jpg",
      "image/jpeg",
    );

    expect(requestUrl).toContain("api.cloudinary.com/v1_1/testcloud/image/upload");
    expect(hasSignature).toBe(true);
    expect(url).toBe(
      "https://res.cloudinary.com/testcloud/image/upload/v1/token-launches/abc.jpg",
    );
  });

  it("returns null when Cloudinary env is missing", async () => {
    delete process.env.CLOUDINARY_API_SECRET;
    const url = await uploadLaunchImage(new Uint8Array([1]), "x.jpg", "image/jpeg");
    expect(url).toBeNull();
  });
});
