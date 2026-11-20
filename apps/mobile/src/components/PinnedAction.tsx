// Full-width pill action pinned 34px above the home indicator.

import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { spacing } from '../theme';

type Props = {
  children: React.ReactNode;
};

export function PinnedAction({ children }: Props) {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.wrap,
        { paddingBottom: Math.max(insets.bottom, spacing.homeIndicator) },
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: spacing.screenPad,
    right: spacing.screenPad,
    bottom: 0,
  },
});
