/** 390×844 iPhone screen: white canvas, status bar, home indicator. Content area starts under the status bar. */
export interface PhoneProps {
  children?: React.ReactNode;
  /** data-screen-label for comments */
  label?: string;
  style?: React.CSSProperties;
}
export function Phone(props: PhoneProps): JSX.Element;
