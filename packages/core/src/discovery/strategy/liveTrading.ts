export const LIVE_TRADING_PAUSED_MESSAGE = "live trading is off.";

export const PAPER_TRADING_OFF_MESSAGE = "paper trading and automated strategies are off.";

/**
 * Temporary kill switch for new live perp opens/promotions.
 * Paper trading still uses Avantis mark data, so this must stay separate from
 * the broader AVANTIS_ENABLED/isAvantisLive market-data gates.
 */
export function isStrategyLiveTradingEnabled(): boolean {
  return process.env.STRATEGY_LIVE_TRADING_ENABLED === "true";
}

export function isStrategyLiveTradingPaused(): boolean {
  return !isStrategyLiveTradingEnabled();
}
