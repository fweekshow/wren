/** The fee, shown once, inside the total. Wren takes $2.99; card adds one 1% line. */
export interface FeeLineProps {
  /** send amount in dollars */
  amount: number | string;
  pay?: 'applepay' | 'card';
  style?: React.CSSProperties;
}
export function FeeLine(props: FeeLineProps): JSX.Element;
