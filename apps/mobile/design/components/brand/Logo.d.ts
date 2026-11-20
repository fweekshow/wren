/**
 * Logo — the Wren mark. A blue chat bird (assets/logo.png). This is the app icon and the logo.
 * @startingPoint section="Brand" subtitle="The logo and app icon" viewport="700x280"
 */
export interface LogoProps {
  /** Rendered width in px; height = width × 0.88. Default 96. */
  size?: number;
  /** Override image URL. Otherwise resolved from window.WREN_ASSETS or the bundle's assets/ folder. */
  src?: string;
  style?: React.CSSProperties;
  title?: string;
}
export function Logo(props: LogoProps): JSX.Element;
