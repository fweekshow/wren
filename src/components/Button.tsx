// The one pinned action. Primary is the only place #0000FF appears.
// Pressed → #0000C8 + scale 0.97 at 120ms.

import React, { useRef } from 'react';
import {
  Animated,
  GestureResponderEvent,
  Pressable,
  StyleProp,
  StyleSheet,
  Text,
  ViewStyle,
} from 'react-native';
import { color, radius, spacing, type } from '../theme';

type Variant = 'primary' | 'secondary' | 'ghost';

type Props = {
  children: React.ReactNode;
  variant?: Variant;
  disabled?: boolean;
  loading?: boolean;
  onPress?: (e: GestureResponderEvent) => void;
  style?: StyleProp<ViewStyle>;
};

const VARIANT = {
  primary: { bg: color.action, bgDown: color.actionPressed, fg: color.textOnAction },
  secondary: { bg: color.card, bgDown: color.pressed, fg: color.textPrimary },
  ghost: { bg: 'transparent', bgDown: color.card, fg: color.textPrimary },
} as const;

export function Button({
  children,
  variant = 'primary',
  disabled = false,
  loading = false,
  onPress,
  style,
}: Props) {
  const scale = useRef(new Animated.Value(1)).current;
  const down = useRef(new Animated.Value(0)).current;
  const v = VARIANT[variant];

  const press = (to: number) => {
    Animated.timing(scale, {
      toValue: to === 1 ? 0.97 : 1,
      duration: 120,
      useNativeDriver: true,
    }).start();
    Animated.timing(down, {
      toValue: to,
      duration: 120,
      useNativeDriver: false,
    }).start();
  };

  const bg = down.interpolate({
    inputRange: [0, 1],
    outputRange: [v.bg, v.bgDown],
  });

  return (
    <Pressable
      disabled={disabled || loading}
      onPressIn={() => press(1)}
      onPressOut={() => press(0)}
      onPress={onPress}
      hitSlop={6}
      accessibilityRole="button"
      style={style}
    >
      <Animated.View
        style={[
          styles.base,
          { backgroundColor: bg, transform: [{ scale }], opacity: disabled ? 0.32 : 1 },
        ]}
      >
        <Text style={[styles.label, { color: v.fg }]}>
          {loading ? '…' : children}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    height: spacing.buttonHLg,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  label: {
    ...type.button,
  },
});
