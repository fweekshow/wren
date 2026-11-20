// Round face with one initial on a Wren-blue tint. No photos, no handles.

import React from 'react';
import { StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { color, font } from '../theme';

const TINTS = [color.wrenTint, color.wrenBelly];

type Props = {
  name: string;
  size?: number;
  selected?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function Avatar({ name, size = 64, selected = false, style }: Props) {
  const i = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % TINTS.length;
  const bg = TINTS[i];
  const ringW = selected ? 2.5 : 0;
  const padded = size + ringW * 2 + 6;
  return (
    <View
      style={[
        {
          width: padded,
          height: padded,
          borderRadius: padded / 2,
          padding: 3,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: ringW,
          borderColor: color.wrenBody,
        },
        style,
      ]}
    >
      <View
        style={[
          styles.face,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: bg,
          },
        ]}
      >
        <Text
          style={{
            fontFamily: font.display,
            fontSize: Math.round(size * 0.4),
            lineHeight: Math.round(size * 0.4),
            letterSpacing: -Math.round(size * 0.4 * 0.03),
            color: color.wrenWing,
          }}
        >
          {name.slice(0, 1).toUpperCase()}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  face: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
