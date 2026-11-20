/**
 * Pill button. Primary (electric blue) is THE one action on a screen — never more than one per screen.
 * @startingPoint section="Core" subtitle="Pill buttons: primary, secondary, ghost" viewport="700x220"
 */
export interface ButtonProps {
  children?: React.ReactNode;
  /** primary = electric blue, the one action; secondary = slate card fill; ghost = text only */
  variant?: 'primary' | 'secondary' | 'ghost';
  /** lg 60px (pinned actions), md 48px, sm 36px */
  size?: 'lg' | 'md' | 'sm';
  full?: boolean;
  disabled?: boolean;
  icon?: React.ReactNode;
  onClick?: () => void;
  style?: React.CSSProperties;
}
export function Button(props: ButtonProps): JSX.Element;
