// 3×4 numeric keypad. Taps return a key — the caller runs it through applyKey
// to produce the next amount string. Pressed key gets a Gray 10 pill.

import React from 'react';
import { Pressable, StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { color, radius, type } from '../theme';
import { Icon } from './Icon';

const KEYS: ReadonlyArray<string> = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'del'];

type Props = {
  onKey: (k: string) => void;
  keyHeight?: number;
  style?: StyleProp<ViewStyle>;
};

export function Keypad({ onKey, keyHeight = 56, style }: Props) {
  return (
    <View style={[styles.grid, style]}>
      {KEYS.map((k) => (
        <Key key={k} k={k} h={keyHeight} onPress={() => onKey(k)} />
      ))}
    </View>
  );
}

function Key({ k, h, onPress }: { k: string; h: number; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={k === 'del' ? 'Delete' : k}
      style={({ pressed }) => [
        styles.key,
        { height: h, backgroundColor: pressed ? color.card : 'transparent' },
      ]}
    >
      {k === 'del' ? (
        <Icon name="delete" size={26} color={color.ink} />
      ) : (
        <Text style={styles.label}>{k}</Text>
      )}
    </Pressable>
  );
}

export function applyKey(current: string, k: string): string {
  let s = String(current ?? '');
  if (k === 'del') return s.slice(0, -1);
  if (k === '.') return s.includes('.') ? s : (s || '0') + '.';
  if (s.includes('.') && s.split('.')[1].length >= 2) return s;
  if (s === '0') s = '';
  if (s.replace('.', '').length >= 6) return s;
  return s + k;
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: 8,
    rowGap: 2,
  },
  key: {
    flexBasis: '32%',
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
  },
  label: {
    ...type.key,
    color: color.ink,
  },
});
