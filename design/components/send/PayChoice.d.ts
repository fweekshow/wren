/** The one pay control: Apple Pay (default, obvious) or Card. */
export interface PayChoiceProps {
  value?: 'applepay' | 'card';
  onChange?: (v: 'applepay' | 'card') => void;
  style?: React.CSSProperties;
}
export function PayChoice(props: PayChoiceProps): JSX.Element;
