/** The blunt big number — portfolio total or send amount, in Inter Tight. */
export interface BigNumberProps {
  value: number;
  /** total = 64px (Home), amount = 88px (Amount screen) */
  size?: 'total' | 'amount';
  /** show raised .00 cents (tertiary color). Turn off for whole-dollar send amounts. */
  cents?: boolean;
  color?: string;
  style?: React.CSSProperties;
}
export function BigNumber(props: BigNumberProps): JSX.Element;
