// Big dollar display. The "$" is small and raised; cents are small and gray.
// Usage: <BigNumber value={total} /> (total) or size="amount" (keypad entry).

import React from 'react';
import { StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { color, type } from '../theme';

type Props = {
  value: number;
  size?: 'total' | 'amount';
  cents?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function BigNumber({ value, size = 'total', cents = true, style }: Props) {
  const n = Number(value) || 0;
  const [whole, frac] = n.toFixed(2).split('.');
  const w = Number(whole).toLocaleString('en-US');
  const base = size === 'amount' ? type.amount : type.total;
  const sideSize = Math.round(base.fontSize * 0.55);

  return (
    <View style={[styles.row, style]}>
      <Text
        style={[
          styles.text,
          base,
          {
            fontSize: sideSize,
            lineHeight: sideSize,
            color: color.textPrimary,
            marginTop: Math.round(base.fontSize * 0.08),
            marginRight: 2,
          },
        ]}
      >
        $
      </Text>
      <Text style={[styles.text, base, { color: color.textPrimary }]}>{w}</Text>
      {cents && (
        <Text
          style={[
            styles.text,
            base,
            {
              fontSize: sideSize,
              lineHeight: sideSize,
              color: color.textTertiary,
              marginTop: Math.round(base.fontSize * 0.08),
              marginLeft: 3,
            },
          ]}
        >
          .{frac}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  text: {
    // tabular numerals keep digits aligned as the user types
    fontVariant: ['tabular-nums'],
  },
});
