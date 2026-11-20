// What a send costs, shown before Pay. Mirrors the server exactly for dollar
// sends: packages/core/src/discovery/stocks/giftStock.service.ts →
// giftOnrampUsd(). Wren takes 1% (STOCK_GIFT_FEE_BPS), the card checkout
// takes ~2.5% (COINBASE_HEADLESS_CARD_BPS) off the top, and the charge is
// never below $2 (ONRAMP_MIN_USD). Change both together.

const WREN_FEE_BPS = 100;
const CARD_BPS = 250;
const MIN_CHARGE_USD = 2;

const round = (n: number) => Math.round(n * 100) / 100;
const ceil = (n: number) => Math.ceil(n * 100 - 1e-9) / 100;

export function sendTotal(usd: number): { totalUsd: number; feesUsd: number } {
  const stock = round(Math.max(0, usd));
  const needed = round(stock + round((stock * WREN_FEE_BPS) / 10_000));
  const totalUsd = Math.max(ceil(needed / (1 - CARD_BPS / 10_000)), MIN_CHARGE_USD);
  return { totalUsd, feesUsd: round(totalUsd - stock) };
}

export function usd2(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
