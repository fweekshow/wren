/** Small move chip. Green fill when up, red fill when down, ink text. The ONLY place green and red appear. */
export interface ChangeProps {
  /** percent, e.g. 1.24 or -0.8 */
  value: number;
  style?: React.CSSProperties;
}
export function Change(props: ChangeProps): JSX.Element;
