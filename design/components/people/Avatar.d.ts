/** A round face: Wren-blue tint with the first initial. People share Wren’s blue family. */
export interface AvatarProps {
  /** first name */
  name: string;
  /** diameter px, default 64 */
  size?: number;
  style?: React.CSSProperties;
}
export function Avatar(props: AvatarProps): JSX.Element;
