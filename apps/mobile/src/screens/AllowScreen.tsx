// One-time OK so Wren can finish a send after the person pays.
// One headline, three numbered lines in a gray card. One blue pill.

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, layout, radius, spacing, type } from '../theme';
import { TopBar } from '../components/HeaderBack';
import { Button } from '../components/Button';
import { PinnedAction } from '../components/PinnedAction';
import { copy } from '../copy';

type Props = {
  onAllow: () => void;
  busy?: boolean;
};

export function AllowScreen({ onAllow, busy = false }: Props) {
  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <TopBar />
      <View style={styles.stage}>
        <Text style={styles.title}>{copy.allowTitle}</Text>
        <Text style={styles.body}>{copy.allowBody}</Text>
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
        <Text style={styles.trust}>{copy.allowTrust}</Text>
      </View>
      <PinnedAction>
        <Button onPress={onAllow} loading={busy}>
          {copy.allowButton}
        </Button>
      </PinnedAction>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.canvas },
  stage: {
    flex: 1,
    paddingHorizontal: spacing.screenPad,
    paddingTop: layout.titleGap,
  },
  title: { ...type.headline, color: color.ink },
  body: { ...type.bodyRegular, color: color.textSecondary, marginTop: 14 },
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
  trust: { ...type.label, color: color.ink, marginTop: 20 },
  line: {
    ...type.bodyRegular,
    color: color.ink,
    flex: 1,
  },
});
