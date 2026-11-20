import type {
  PortfolioReviewPlatform,
  PortfolioReviewSubscriptionRow,
} from "@/discovery/adapters/portfolioReview.adapter.js";
import { createDeliveryRegistry } from "@/infra/deliveryRegistry.js";

export type PortfolioReviewDeliveryFn = (
  subscription: PortfolioReviewSubscriptionRow,
  message: string,
) => Promise<boolean>;

export function parseReviewDmTarget<T = Record<string, unknown>>(
  subscription: PortfolioReviewSubscriptionRow,
): T | null {
  if (!subscription.dm_target) return null;
  try {
    return JSON.parse(subscription.dm_target) as T;
  } catch {
    return null;
  }
}

export const portfolioReviewDelivery = createDeliveryRegistry<
  PortfolioReviewPlatform,
  PortfolioReviewSubscriptionRow
>();
