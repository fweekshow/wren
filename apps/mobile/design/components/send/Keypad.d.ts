/** Number keypad: 1–9, ".", 0, delete. Keys have no fill until pressed. */
export interface KeypadProps {
  /** receives "0"–"9", "." or "del" */
  onKey?: (k: string) => void;
  /** row height, default 56 (hit target ≥ 44) */
  keyHeight?: number;
  style?: React.CSSProperties;
}
export function Keypad(props: KeypadProps): JSX.Element;
