// A plain back chevron that stays at hit-min (44x44). Used on Someone,
// Amount, and the country sheet. TopBar is the same 44px row for screens
// with no back arrow, so headlines start at the same height everywhere.

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { color, layout, spacing, type } from '../theme';
import { Icon } from './Icon';

type Props = {
  onBack: () => void;
  title?: string;
  right?: React.ReactNode;
};

export function HeaderBack({ onBack, title, right }: Props) {
  return (
    <View style={styles.wrap}>
      <Pressable onPress={onBack} hitSlop={10} style={styles.btn}>
        <Icon name="chevron-left" size={28} color={color.ink} />
      </Pressable>
      {!!title && (
        <View style={styles.centerWrap} pointerEvents="none">
          <Text style={styles.title}>{title}</Text>
        </View>
      )}
      <View style={styles.right}>{right}</View>
    </View>
  );
}

export function TopBar({ children }: { children?: React.ReactNode }) {
  return <View style={styles.bar}>{children}</View>;
}

const styles = StyleSheet.create({
  bar: {
    height: layout.topBar,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.screenPad,
  },
  wrap: {
    height: layout.topBar,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
  },
  btn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    justifyContent: 'center',
    height: 44,
  },
  title: { ...type.body, color: color.textPrimary },
  right: { marginLeft: 'auto' },
});
