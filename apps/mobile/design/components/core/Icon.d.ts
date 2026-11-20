/** Lucide icon (copied into assets/icons), stroked with currentColor. Set: chevron-left, search, delete, credit-card, x, check. */
export interface IconProps {
  /** Lucide icon name, e.g. "chevron-left", "search", "delete", "credit-card", "x" */
  name: string;
  size?: number;
  strokeWidth?: number;
  color?: string;
  style?: React.CSSProperties;
}
export function Icon(props: IconProps): JSX.Element;
