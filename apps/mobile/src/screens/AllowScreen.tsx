// One-time OK so Wren can finish a send after the person pays.
// One headline, three numbered lines in a gray card. One blue pill.

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, radius, spacing, type } from '../theme';
import { Button } from '../components/Button';
import { PinnedAction } from '../components/PinnedAction';
import { copy } from '../copy';

type Props = {
  onAllow: () => void;
};

export function AllowScreen({ onAllow }: Props) {
  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.stage}>
        <Text style={styles.title}>{copy.allowTitle}</Text>
        <View style={styles.card}>
          {copy.allowSteps.map((line, i) => (
            <View key={line} style={[styles.row, i === 0 && styles.rowFirst]}>
              <View style={styles.num}>
                <Text style={styles.numText}>{i + 1}</Text>
              </View>
              <Text style={styles.line}>{line}</Text>
            </View>
          ))}
        </View>
      </View>
      <PinnedAction>
        <Button onPress={onAllow}>{copy.allowButton}</Button>
      </PinnedAction>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.canvas },
  stage: {
    flex: 1,
    paddingHorizontal: spacing.screenPad,
    paddingTop: 32,
  },
  title: { ...type.headline, color: color.ink },
  card: {
    marginTop: 32,
    backgroundColor: color.card,
    borderRadius: radius.card,
    paddingVertical: 6,
    paddingHorizontal: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairline,
  },
  rowFirst: { borderTopWidth: 0 },
  num: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: color.canvas,
    alignItems: 'center',
    justifyContent: 'center',
  },
  numText: {
    ...type.label,
    color: color.ink,
  },
  line: {
    ...type.bodyRegular,
    color: color.ink,
    flex: 1,
  },
});
