// Pill-shaped search field. The search icon sits on the left in Gray 50.

import React from 'react';
import { StyleProp, StyleSheet, TextInput, View, ViewStyle } from 'react-native';
import { color, radius, type } from '../theme';
import { Icon } from './Icon';

type Props = {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function SearchField({
  value,
  onChange,
  placeholder = 'Search',
  autoFocus = false,
  style,
}: Props) {
  return (
    <View style={[styles.wrap, style]}>
      <Icon name="search" size={20} color={color.textTertiary} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={color.textTertiary}
        autoFocus={autoFocus}
        autoCorrect={false}
        autoCapitalize="none"
        style={styles.input}
        returnKeyType="search"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    height: 48,
    paddingHorizontal: 18,
    borderRadius: radius.pill,
    backgroundColor: color.card,
  },
  input: {
    flex: 1,
    minWidth: 0,
    padding: 0,
    ...type.bodyRegular,
    color: color.textPrimary,
  },
});
