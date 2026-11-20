// Amount presets: $25 / $50 / $100. Selected pill = ink fill, white text.

import React from 'react';
import { Pressable, StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { color, font, radius } from '../theme';

type Props = {
  options?: number[];
  value: string;
  onChange: (v: number) => void;
  style?: StyleProp<ViewStyle>;
};

export function Presets({ options = [25, 50, 100], value, onChange, style }: Props) {
  const numeric = Number(value);
  return (
    <View style={[styles.row, style]}>
      {options.map((o) => {
        const on = numeric === o;
        return (
          <Pressable
            key={o}
            onPress={() => onChange(o)}
            style={[
              styles.pill,
              { backgroundColor: on ? color.ink : color.card },
            ]}
          >
            <Text
              style={[
                styles.label,
                { color: on ? color.canvas : color.textPrimary },
              ]}
            >
              ${o}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'center', gap: 8 },
  pill: {
    height: 40,
    minWidth: 76,
    paddingHorizontal: 16,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontFamily: font.uiSemiBold,
    fontSize: 16,
    lineHeight: 20,
  },
});
