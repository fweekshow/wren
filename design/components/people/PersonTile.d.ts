/** A person you can send to: round face, first name, and a warm "Has Wren" dot if they already use it. */
export interface PersonTileProps {
  name: string;
  /** shows a small Wren-blue dot + "Has Wren" */
  hasWren?: boolean;
  /** Wren-blue ring around the face */
  selected?: boolean;
  /** face diameter, default 72 */
  size?: number;
  onClick?: () => void;
}
export function PersonTile(props: PersonTileProps): JSX.Element;
