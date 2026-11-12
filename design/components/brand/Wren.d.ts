/**
 * Wren — the bird, the mascot and the logo. Renders the official art (assets/wren.png): blue side-profile bird facing right.
 * @startingPoint section="Brand" subtitle="Wren, the mascot" viewport="700x260"
 */
export interface WrenProps {
  /** Reserved for future pose art; all values render the official mascot today. */
  pose?: 'perch' | 'point' | 'carry' | 'cheer';
  /** Rendered width in px; height = width × 0.84. Default 160. */
  size?: number;
  /** Override image URL. Otherwise resolved from window.WREN_ASSETS or the bundle's assets/ folder. */
  src?: string;
  /** Mirror to face left */
  flip?: boolean;
  style?: React.CSSProperties;
  title?: string;
}
export function Wren(props: WrenProps): JSX.Element;
