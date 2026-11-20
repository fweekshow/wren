import { config } from "@/config/config.js";
import { logger } from "@/utils/logger.js";

import type {
  FlashApiErrorBody,
  FlashFill,
  FlashOrderDetail,
  FlashOrderRequest,
  FlashOrderSubmitResponse,
  FlashQuoteRequest,
  FlashQuoteResponse,
} from "./types.js";

const FLASH_BASE_URL = "https://flash.definitive.fi/v1";

export class FlashApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "FlashApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function apiKey(): string {
  const key = config.flash.apiKey.trim();
  if (!key) throw new FlashApiError(401, "MISSING_API_KEY", "FLASH_API_KEY is not configured.");
  return key;
}

async function flashFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${FLASH_BASE_URL}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-definitive-api-key": apiKey(),
      ...(init?.headers ?? {}),
    },
  });

  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }

  if (!res.ok) {
    const errBody = body as FlashApiErrorBody | null;
    const code = errBody?.error?.code ?? `HTTP_${res.status}`;
    const message = errBody?.error?.message ?? `Flash API ${res.status} on ${path}`;
    logger.warn({ status: res.status, code, path, body }, "[flash] API error");
    throw new FlashApiError(res.status, code, message, errBody?.error?.details);
  }

  return body as T;
}

export async function flashQuote(req: FlashQuoteRequest): Promise<FlashQuoteResponse> {
  return flashFetch<FlashQuoteResponse>("/quote", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function flashSubmitOrder(req: FlashOrderRequest): Promise<FlashOrderSubmitResponse> {
  return flashFetch<FlashOrderSubmitResponse>("/order", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function flashGetOrder(args: {
  orderId: string;
  funderAddress: string;
}): Promise<FlashOrderDetail> {
  const params = new URLSearchParams({ funderAddress: args.funderAddress });
  const body = await flashFetch<{ order?: FlashOrderDetail; fills?: FlashFill[] } & FlashOrderDetail>(
    `/orders/${encodeURIComponent(args.orderId)}?${params.toString()}`,
  );
  // API returns `{ order, fills }`; normalize so callers always see fills on the detail.
  const order = body.order ?? (body as FlashOrderDetail);
  const fills = body.fills ?? order.fills ?? [];
  return { ...order, fills };
}

export async function flashListOrders(args: {
  funderAddress: string;
  pageSize?: number;
}): Promise<{ orders: FlashOrderDetail[] }> {
  const params = new URLSearchParams({
    funderAddress: args.funderAddress,
  });
  if (args.pageSize) params.set("pageSize", String(args.pageSize));
  return flashFetch<{ orders: FlashOrderDetail[] }>(`/orders?${params.toString()}`);
}

export function flashCancelMessage(orderId: string): string {
  return `Definitive Flash v1 — Cancel Order\nOrder: ${orderId}`;
}

export async function flashCancelOrder(args: {
  orderId: string;
  cancelMessage: string;
  userSignature: string;
}): Promise<{ ok: true }> {
  return flashFetch<{ ok: true }>(`/orders/${encodeURIComponent(args.orderId)}/cancel`, {
    method: "POST",
    body: JSON.stringify({
      cancelMessage: args.cancelMessage,
      userSignature: args.userSignature,
    }),
  });
}
