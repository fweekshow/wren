import type {
  AlertPlatform,
  PriceAlertRow,
} from "@/discovery/adapters/priceAlert.adapter.js";
import { createDeliveryRegistry } from "@/infra/deliveryRegistry.js";

/**
 * Sends a fired alert to a user's DM. Returns true on success. Each platform
 * registers its own implementation (XMTP DM, iMessage space send) at startup.
 */
export type AlertDeliveryFn = (
  alert: PriceAlertRow,
  message: string,
) => Promise<boolean>;

/** Parse the platform-specific `dm_target` JSON stored with an alert. */
export function parseDmTarget<T = Record<string, unknown>>(
  alert: PriceAlertRow,
): T | null {
  if (!alert.dm_target) return null;
  try {
    return JSON.parse(alert.dm_target) as T;
  } catch {
    return null;
  }
}

/** Process-wide registry of per-platform DM delivery functions. */
export const priceAlertDelivery = createDeliveryRegistry<AlertPlatform, PriceAlertRow>();
