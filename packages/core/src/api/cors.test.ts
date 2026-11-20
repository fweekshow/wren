import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCorsMiddleware, parseAllowedOrigins } from "./cors.js";

const savedEnv = {
  CORS_ALLOWED_ORIGINS: process.env.CORS_ALLOWED_ORIGINS,
  KEYWORDS_CORS_ORIGINS: process.env.KEYWORDS_CORS_ORIGINS,
  NODE_ENV: process.env.NODE_ENV,
};

function mockResponse() {
  const headers = new Map<string, string>();
  let statusCode = 200;
  let ended = false;

  const res = {
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
      return res;
    },
    status(code: number) {
      statusCode = code;
      return res;
    },
    end() {
      ended = true;
      return res;
    },
  } as unknown as Response;

  return {
    res,
    getHeader: (name: string) => headers.get(name.toLowerCase()),
    getStatus: () => statusCode,
    didEnd: () => ended,
  };
}

function runMiddleware(method: string, origin?: string) {
  const req = {
    method,
    headers: origin ? { origin } : {},
  } as Request;
  const response = mockResponse();
  const next = vi.fn();
  createCorsMiddleware(["GET", "POST", "PATCH", "DELETE", "OPTIONS"])(req, response.res, next);
  return { ...response, next };
}

describe("parseAllowedOrigins", () => {
  it("fails closed in production when no CORS env is configured", () => {
    expect(parseAllowedOrigins({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toEqual(new Set());
  });

  it("defaults to localhost in development", () => {
    expect(parseAllowedOrigins({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toEqual(
      new Set(["http://localhost:3000"]),
    );
  });

  it("uses KEYWORDS_CORS_ORIGINS as a fallback", () => {
    expect(
      parseAllowedOrigins({
        NODE_ENV: "production",
        KEYWORDS_CORS_ORIGINS: "https://basemate.app",
      } as NodeJS.ProcessEnv),
    ).toEqual(new Set(["https://basemate.app"]));
  });
});

describe("createCorsMiddleware", () => {
  beforeEach(() => {
    process.env.CORS_ALLOWED_ORIGINS = "https://basemate.app";
    delete process.env.KEYWORDS_CORS_ORIGINS;
    process.env.NODE_ENV = "production";
  });

  afterEach(() => {
    if (savedEnv.CORS_ALLOWED_ORIGINS === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
    else process.env.CORS_ALLOWED_ORIGINS = savedEnv.CORS_ALLOWED_ORIGINS;
    if (savedEnv.KEYWORDS_CORS_ORIGINS === undefined) delete process.env.KEYWORDS_CORS_ORIGINS;
    else process.env.KEYWORDS_CORS_ORIGINS = savedEnv.KEYWORDS_CORS_ORIGINS;
    if (savedEnv.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedEnv.NODE_ENV;
  });

  it("sets CORS headers for allowed origins", () => {
    const result = runMiddleware("GET", "https://basemate.app");

    expect(result.getHeader("Access-Control-Allow-Origin")).toBe("https://basemate.app");
    expect(result.getHeader("Vary")).toBe("Origin");
    expect(result.next).toHaveBeenCalledTimes(1);
  });

  it("does not set CORS headers for disallowed origins but still reaches the route", () => {
    const result = runMiddleware("GET", "https://evil.example");

    expect(result.getHeader("Access-Control-Allow-Origin")).toBeUndefined();
    expect(result.next).toHaveBeenCalledTimes(1);
  });

  it("answers allowed preflight requests with 204", () => {
    const result = runMiddleware("OPTIONS", "https://basemate.app");

    expect(result.getStatus()).toBe(204);
    expect(result.didEnd()).toBe(true);
    expect(result.next).not.toHaveBeenCalled();
  });

  it("rejects disallowed preflight requests with 403", () => {
    const result = runMiddleware("OPTIONS", "https://evil.example");

    expect(result.getStatus()).toBe(403);
    expect(result.didEnd()).toBe(true);
    expect(result.next).not.toHaveBeenCalled();
  });
});
