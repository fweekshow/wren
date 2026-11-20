/**
 * Generic process-wide registry that maps a platform key to a DM delivery
 * function. Used by portfolio-reviews and price-alerts so both can share
 * the same Map-based registration/dispatch pattern without duplicating it.
 */
export interface PlatformDeliveryRegistry<P extends string, T extends { platform: P }> {
  register(platform: P, fn: (payload: T, message: string) => Promise<boolean>): void;
  get(platform: P): ((payload: T, message: string) => Promise<boolean>) | undefined;
  deliver(payload: T, message: string): Promise<boolean>;
}

export function createDeliveryRegistry<
  P extends string,
  T extends { platform: P },
>(): PlatformDeliveryRegistry<P, T> {
  const fns = new Map<P, (payload: T, message: string) => Promise<boolean>>();
  return {
    register(platform, fn) {
      fns.set(platform, fn);
    },
    get(platform) {
      return fns.get(platform);
    },
    async deliver(payload, message) {
      const fn = fns.get(payload.platform);
      if (!fn) return false;
      return fn(payload, message);
    },
  };
}
