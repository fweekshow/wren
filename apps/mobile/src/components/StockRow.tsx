// A single stock holding row inside the Home card.

import React from 'react';
import { Pressable, StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { color, type } from '../theme';
import { Icon } from './Icon';

type Props = {
  name: string;
  symbol: string;
  value?: number;
  last?: boolean;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
};

export function StockRow({ name, symbol, value, last = false, onPress, style }: Props) {
  const row = (
    <View
      style={[
        styles.row,
        !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.hairline },
        style,
      ]}
    >
      <View style={styles.left}>
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        <Text style={styles.ticker}>{symbol}</Text>
      </View>
      {value != null ? (
        <Text style={styles.value}>
          ${Number(value).toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}
        </Text>
      ) : (
        <Icon name="chevron-left" size={18} color={color.textTertiary} style={styles.chevron} />
      )}
    </View>
  );
  if (!onPress) return row;
  return (
    <Pressable onPress={onPress} accessibilityRole="button">
      {row}
    </Pressable>
  );
}

type ListProps = {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
};

export function StockList({ children, style }: ListProps) {
  return <View style={[styles.list, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  list: {
    backgroundColor: color.card,
    borderRadius: 20,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    minHeight: 72,
    gap: 12,
  },
  left: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 14,
  },
  name: { ...type.body, color: color.textPrimary },
  ticker: { ...type.ticker, color: color.textSecondary, marginTop: 2 },
  value: { ...type.price, color: color.textPrimary },
  chevron: { transform: [{ rotate: '180deg' }] },
});
