// Big dollar display. The "$" is small and raised; cents are small and quieter.
// size="total" (Home, 64), "amount" (88) or "amountXl" (104, inside the
// amount bubble). tone="onBlue" for white digits on a Wren Blue bubble.
// fitWidth shrinks the digits so long amounts never wrap or clip.

import React from 'react';
import { StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { color, type } from '../theme';

type Props = {
  value: number;
  size?: 'total' | 'amount' | 'amountXl';
  cents?: boolean;
  tone?: 'ink' | 'onBlue';
  align?: 'center' | 'left';
  fitWidth?: number;
  style?: StyleProp<ViewStyle>;
};

// Inter Tight medium digits run about 0.6em wide at these tracking values.
const DIGIT_EM = 0.6;

export function BigNumber({
  value,
  size = 'total',
  cents = true,
  tone = 'ink',
  align = 'center',
  fitWidth,
  style,
}: Props) {
  const n = Number(value) || 0;
  const [whole, frac] = n.toFixed(2).split('.');
  const w = Number(whole).toLocaleString('en-US');
  const spec = size === 'amountXl' ? type.amountXl : size === 'amount' ? type.amount : type.total;

  // "$" and ".00" are 0.55 size each; count them as about one and a half digits.
  const ems = w.length * DIGIT_EM + (cents ? 1.5 : 0.5) * DIGIT_EM;
  const fontSize = fitWidth ? Math.min(spec.fontSize, Math.floor(fitWidth / ems)) : spec.fontSize;
  const k = fontSize / spec.fontSize;
  const base = {
    ...spec,
    fontSize,
    lineHeight: Math.round(spec.lineHeight * k),
    letterSpacing: spec.letterSpacing * k,
  };
  const sideSize = Math.round(fontSize * 0.55);
  const ink = tone === 'onBlue' ? color.textOnAction : color.textPrimary;
  const quiet = tone === 'onBlue' ? color.wrenBelly : color.textTertiary;
  const side = {
    fontSize: sideSize,
    lineHeight: sideSize,
    letterSpacing: 0,
    marginTop: Math.round(fontSize * 0.08),
  };

  return (
    <View style={[styles.row, align === 'left' && styles.left, style]}>
      <Text style={[styles.text, base, side, { color: ink, marginRight: 2 }]}>$</Text>
      <Text style={[styles.text, base, { color: ink }]}>{w}</Text>
      {cents && <Text style={[styles.text, base, side, { color: quiet, marginLeft: 3 }]}>.{frac}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  left: { justifyContent: 'flex-start' },
  text: {
    // tabular numerals keep digits aligned as the user types
    fontVariant: ['tabular-nums'],
  },
});
