// A plain back chevron that stays at hit-min (44x44). Used on Someone,
// Amount, and the country sheet.

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { color, type } from '../theme';
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

const styles = StyleSheet.create({
  wrap: {
    height: 44,
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
