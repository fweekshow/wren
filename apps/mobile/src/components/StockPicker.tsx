// Horizontal scrolling row of company-name pills on the Amount screen.
// Selected pill = 1.5px ink outline on canvas; others sit flat on cards.

import React from 'react';
import {
  Pressable,
  ScrollView,
  StyleProp,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from 'react-native';
import { color, radius, type } from '../theme';
import type { Stock } from '../api';

type Props = {
  stocks: Stock[];
  value?: string; // symbol
  onChange: (symbol: string) => void;
  style?: StyleProp<ViewStyle>;
};

export function StockPicker({ stocks, value, onChange, style }: Props) {
  if (!stocks.length) {
    return <View style={[{ height: 36 }, style]} />;
  }
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      style={[{ alignSelf: 'stretch' }, style]}
    >
      {stocks.map((s, i) => {
        const on = s.symbol === value;
        return (
          <Pressable
            key={s.symbol}
            onPress={() => onChange(s.symbol)}
            style={[
              styles.pill,
              on ? styles.pillOn : styles.pillOff,
              i === 0 && { marginLeft: 0 },
            ]}
          >
            <Text style={styles.label} numberOfLines={1}>
              {s.name}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', paddingHorizontal: 20, gap: 8 },
  pill: {
    height: 36,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
  },
  pillOn: { backgroundColor: color.canvas, borderColor: color.ink },
  pillOff: { backgroundColor: color.card, borderColor: 'transparent' },
  label: { ...type.label, color: color.textPrimary },
});
