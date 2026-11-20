import { formatUnits } from "viem";

export interface PricedTokenInfo {
  symbol: string;
  priceUsd: number | null;
}

function stableLike(symbol: string, priceUsd: number): boolean {
  return /USD/i.test(symbol) && priceUsd >= 0.8 && priceUsd <= 1.2;
}

export function decodeTokenAmount(
  raw: bigint,
  decimals: number,
  token: PricedTokenInfo,
): { amount: number; decimals: number } {
  const initial = Number(formatUnits(raw, decimals));
  if (
    Number.isFinite(initial) &&
    initial > 0 &&
    (!stableLike(token.symbol, token.priceUsd ?? 0) || initial < 1_000_000_000)
  ) {
    return { amount: initial, decimals };
  }

  if (!stableLike(token.symbol, token.priceUsd ?? 0)) {
    return { amount: initial, decimals };
  }

  // Some long-tail stables report broken decimals metadata. Pick a common
  // decimal scale that turns the raw balance into a plausible wallet-sized value.
  for (const candidateDecimals of [18, 15, 12, 9, 8, 6]) {
    const amount = Number(formatUnits(raw, candidateDecimals));
    if (Number.isFinite(amount) && amount >= 1 && amount < 1_000_000) {
      return { amount, decimals: candidateDecimals };
    }
  }

  for (const candidateDecimals of [18, 15, 12, 9, 8, 6]) {
    const amount = Number(formatUnits(raw, candidateDecimals));
    if (Number.isFinite(amount) && amount >= 0.01 && amount < 1_000_000_000) {
      return { amount, decimals: candidateDecimals };
    }
  }

  return { amount: initial, decimals };
}
