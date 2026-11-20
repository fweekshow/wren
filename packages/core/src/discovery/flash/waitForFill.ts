import { isFlashOrderFilled, isFlashOrderTerminalFail } from "./activity.js";
import { flashGetOrder } from "./client.js";
import type { FlashOrderDetail } from "./types.js";

/**
 * Poll Flash until the order is filled or terminal, for market receipt UX.
 */
export async function waitForFlashFill(args: {
  orderId: string;
  funderAddress: string;
  attempts?: number;
  delayMs?: number;
  initial?: FlashOrderDetail | null;
}): Promise<FlashOrderDetail | undefined> {
  const attempts = args.attempts ?? 10;
  const delayMs = args.delayMs ?? 500;
  let detail = args.initial ?? undefined;

  for (let i = 0; i < attempts; i++) {
    if (detail && (isFlashOrderFilled(detail.status) || isFlashOrderTerminalFail(detail.status))) {
      return detail;
    }
    if (i > 0 || !detail) {
      try {
        detail = await flashGetOrder({
          orderId: args.orderId,
          funderAddress: args.funderAddress,
        });
      } catch {
        // keep polling
      }
    }
    if (detail && (isFlashOrderFilled(detail.status) || isFlashOrderTerminalFail(detail.status))) {
      return detail;
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return detail;
}
