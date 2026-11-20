// Who sees your moves: radio cards. Used in Settings.

import React from 'react';
import { Pressable, StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { color, radius, type } from '../theme';
import { Icon } from './Icon';
import { Visibility } from '../api';
import { copy } from '../copy';

export function PrivacyChoices({
  value,
  onChange,
  options,
  style,
}: {
  value: Visibility;
  onChange: (v: Visibility) => void;
  options: Visibility[];
  style?: StyleProp<ViewStyle>;
}) {
  const label = (v: Visibility) => (v === 'only_me' ? copy.visOnlyMe : copy.visYourPeople);
  return (
    <View style={[styles.choices, style]}>
      {options.map((v) => {
        const on = v === value;
        return (
          <Pressable
            key={v}
            onPress={() => onChange(v)}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            style={[styles.choice, on && styles.choiceOn]}
          >
            <View style={styles.choiceText}>
              <Text style={styles.choiceLabel}>{label(v)}</Text>
              <Text style={styles.choiceNote}>{copy.visNote[v]}</Text>
            </View>
            <View style={[styles.radio, on && styles.radioOn]}>
              {on && <Icon name="check" size={14} color={color.textOnAction} strokeWidth={3} />}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  choices: { marginTop: 28, gap: 10 },
  choice: {
    minHeight: 76,
    borderRadius: radius.card,
    backgroundColor: color.card,
    paddingHorizontal: 20,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  choiceOn: { backgroundColor: color.canvas, borderColor: color.ink },
  choiceText: { flex: 1, gap: 2 },
  choiceLabel: { ...type.body, color: color.ink },
  choiceNote: { ...type.caption, color: color.textSecondary },
  radio: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: color.hairline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOn: { backgroundColor: color.ink, borderColor: color.ink },
});
