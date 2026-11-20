/** Pill search input at the top of the people screen. */
export interface SearchFieldProps {
  value?: string;
  onChange?: (v: string) => void;
  placeholder?: string;
  style?: React.CSSProperties;
}
export function SearchField(props: SearchFieldProps): JSX.Element;
