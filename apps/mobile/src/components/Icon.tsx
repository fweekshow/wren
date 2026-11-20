// A tiny Lucide-copy icon set. Same five we need: chevron-left, search,
// delete, x, check. Drawn with react-native-svg paths copied verbatim.

import React from 'react';
import { StyleProp, ViewStyle } from 'react-native';
import Svg, { Path, Circle } from 'react-native-svg';
import { color } from '../theme';

export type IconName = 'chevron-left' | 'search' | 'delete' | 'x' | 'check' | 'settings';

type Props = {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
  style?: StyleProp<ViewStyle>;
};

export function Icon({
  name,
  size = 24,
  color: stroke = color.ink,
  strokeWidth = 2,
  style,
}: Props) {
  const common = {
    stroke,
    strokeWidth,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    fill: 'none' as const,
  };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" style={style as any}>
      {name === 'chevron-left' && <Path d="m15 18-6-6 6-6" {...common} />}
      {name === 'search' && (
        <>
          <Circle cx="11" cy="11" r="8" {...common} />
          <Path d="m21 21-4.3-4.3" {...common} />
        </>
      )}
      {name === 'delete' && (
        <>
          <Path
            d="M10 5a2 2 0 0 0-1.344.519l-6.328 5.74a1 1 0 0 0 0 1.481l6.328 5.741A2 2 0 0 0 10 19h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z"
            {...common}
          />
          <Path d="m12 9 6 6" {...common} />
          <Path d="m18 9-6 6" {...common} />
        </>
      )}
      {name === 'x' && (
        <>
          <Path d="M18 6 6 18" {...common} />
          <Path d="m6 6 12 12" {...common} />
        </>
      )}
      {name === 'check' && <Path d="M20 6 9 17l-5-5" {...common} />}
      {name === 'settings' && (
        <>
          <Path
            d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
            {...common}
          />
          <Circle cx={12} cy={12} r={3} {...common} />
        </>
      )}
    </Svg>
  );
}
