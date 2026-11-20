// The official Wren mascot. Uncropped PNG from design/assets/wren.png.
// Aspect ratio 640:537 (from the source art).

import React from 'react';
import { Image, ImageStyle, StyleProp } from 'react-native';

const ART = require('../../assets/wren.png');
const RATIO = 537 / 640;

type Props = {
  size?: number;
  style?: StyleProp<ImageStyle>;
};

export function Wren({ size = 160, style }: Props) {
  return (
    <Image
      source={ART}
      accessibilityLabel="Wren"
      style={[{ width: size, height: Math.round(size * RATIO) }, style]}
      resizeMode="contain"
    />
  );
}
