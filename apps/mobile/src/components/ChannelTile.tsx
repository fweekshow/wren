// iMessage / WhatsApp tile on Connect. A bubble card you can tap.
// Off: Wren tint with an ink "Turn on" pill. On: Wren Blue with a white "On" pill.

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { color, font, radius, type } from '../theme';
import { copy } from '../copy';

type Props = {
  name: string;
  sub: string;
  on: boolean;
  onPress: () => void;
};

export function ChannelTile({ name, sub, on, onPress }: Props) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${name}. ${on ? copy.connectOn : copy.connectTurnOn}`}
      style={({ pressed }) => [
        styles.tile,
        { backgroundColor: on ? color.wrenBody : color.wrenTint },
        pressed && styles.pressed,
      ]}
    >
      <View style={styles.top}>
        <View style={[styles.pill, { backgroundColor: on ? color.canvas : color.ink }]}>
          <Text style={[styles.pillText, { color: on ? color.wrenBody : color.textOnAction }]}>
            {on ? copy.connectOn : copy.connectTurnOn}
          </Text>
        </View>
      </View>
      <View>
        <Text style={[type.tileName, { color: on ? color.textOnAction : color.ink }]}>{name}</Text>
        <Text style={[styles.sub, { color: on ? color.wrenTint : color.textSecondary }]}>{sub}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: {
    minHeight: 160,
    borderRadius: radius.bubble,
    borderBottomRightRadius: radius.bubbleTail,
    padding: 22,
    justifyContent: 'space-between',
    gap: 20,
  },
  pressed: { transform: [{ scale: 0.98 }] },
  top: { flexDirection: 'row', justifyContent: 'flex-end' },
  pill: {
    height: 40,
    paddingHorizontal: 18,
    borderRadius: radius.pill,
    justifyContent: 'center',
  },
  pillText: { fontFamily: font.uiSemiBold, fontSize: 15 },
  sub: { fontFamily: font.ui, fontSize: 16, lineHeight: 21, marginTop: 8 },
});
