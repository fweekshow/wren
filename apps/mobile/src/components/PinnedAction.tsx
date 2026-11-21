// Full-width pill action pinned 34px above the home indicator, on a strip of
// canvas so scrolling content never shows around it. When the keyboard is up
// it rides just above the keyboard, so Continue is never hidden behind it.

import React, { useEffect, useState } from 'react';
import { Keyboard, Platform, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, spacing } from '../theme';

type Props = {
  children: React.ReactNode;
};

function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const show = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hide = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const a = Keyboard.addListener(show, (e) => setHeight(e.endCoordinates.height));
    const b = Keyboard.addListener(hide, () => setHeight(0));
    return () => {
      a.remove();
      b.remove();
    };
  }, []);
  return height;
}

export function PinnedAction({ children }: Props) {
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();
  return (
    <View
      style={[
        styles.wrap,
        keyboard > 0
          ? { bottom: keyboard, paddingBottom: 12 }
          : { paddingBottom: Math.max(insets.bottom, spacing.homeIndicator) },
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: 16,
    paddingHorizontal: spacing.screenPad,
    backgroundColor: color.canvas,
  },
});
