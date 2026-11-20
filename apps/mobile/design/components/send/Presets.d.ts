/** Preset amount pills: $25, $50, $100. Selected is ink-filled. */
export interface PresetsProps {
  options?: number[];
  value?: number | string;
  onChange?: (v: number) => void;
  style?: React.CSSProperties;
}
export function Presets(props: PresetsProps): JSX.Element;
