/** One stock you hold: company, ticker, value, and a small move. Stack inside <StockList>. */
export interface StockRowProps {
  /** Company name: Apple, NVIDIA, Tesla, Microsoft */
  name: string;
  /** AAPL | NVDA | TSLA | MSFT */
  ticker: string;
  /** dollar value held */
  value: number;
  /** percent move today */
  change: number;
  last?: boolean;
  onClick?: () => void;
}
export function StockRow(props: StockRowProps): JSX.Element;
