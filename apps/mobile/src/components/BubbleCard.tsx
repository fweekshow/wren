// Bubble card: a message-shaped card. 32 corners with one 8 corner (the tail).
// Yours: Wren Blue, white text, tail bottom-right. Theirs: Gray 10, tail bottom-left.
// Use for channel tiles, the amount, message previews and the latest send —
// not for lists or settings rows.

import React from 'react';
import { StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { color, radius, type } from '../theme';

type Props = {
  from: 'you' | 'them';
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
};

export function BubbleCard({ from, children, style }: Props) {
  const yours = from === 'you';
  return (
    <View
      style={[
        styles.base,
        yours ? styles.you : styles.them,
        style,
      ]}
    >
      {typeof children === 'string' ? (
        <Text style={[type.bubble, { color: yours ? color.textOnAction : color.ink }]}>{children}</Text>
      ) : (
        children
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radius.bubble,
    paddingHorizontal: 20,
    paddingVertical: 16,
    maxWidth: 300,
  },
  you: {
    alignSelf: 'flex-end',
    backgroundColor: color.wrenBody,
    borderBottomRightRadius: radius.bubbleTail,
  },
  them: {
    alignSelf: 'flex-start',
    backgroundColor: color.card,
    borderBottomLeftRadius: radius.bubbleTail,
  },
});
