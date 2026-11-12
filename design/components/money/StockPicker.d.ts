/** Switch which stock Wren carries. Pills; selected gets an ink outline. */
export interface StockPickerProps {
  stocks: { name: string; ticker: string }[];
  /** selected ticker */
  value: string;
  onChange?: (ticker: string) => void;
  style?: React.CSSProperties;
}
export function StockPicker(props: StockPickerProps): JSX.Element;
