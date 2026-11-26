// One line for what a buy or send costs: "Total $50.99 · Fees $0.99 ˅".
// Tap Fees to see each one. No fees → "No fees" in green, nothing to open.
// Card fees (Apple Pay) aren't here: the Pay card shows its own.

import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { color, type } from '../theme';
import { copy } from '../copy';
import { usd2 } from '../fees';

export type Fee = { label: string; usd: number };

type Props = {
  totalUsd: number;
  fees: Fee[];
  /** Shown after "No fees", e.g. "Your first send is free". */
  freeNote?: string;
};

export function FeesLine({ totalUsd, fees, freeNote }: Props) {
  const [open, setOpen] = useState(false);
  const shown = fees.filter((f) => f.usd > 0.004);
  const feesUsd = shown.reduce((sum, f) => sum + f.usd, 0);

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <Text style={styles.total}>
          {copy.total} {usd2(totalUsd)}
        </Text>
        {shown.length ? (
          <Pressable
            onPress={() => setOpen((o) => !o)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
          >
            <Text style={styles.fees}>
              {copy.fees} {usd2(feesUsd)} {open ? '˄' : '˅'}
            </Text>
          </Pressable>
        ) : (
          <Text style={styles.free}>{freeNote ? `${copy.noFees} · ${freeNote}` : copy.noFees}</Text>
        )}
      </View>
      {open
        ? shown.map((f) => (
            <View key={f.label} style={styles.row}>
              <Text style={styles.detail}>{f.label}</Text>
              <Text style={styles.detail}>{usd2(f.usd)}</Text>
            </View>
          ))
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 4 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  total: { ...type.label, color: color.ink },
  fees: { ...type.label, color: color.textSecondary },
  free: { ...type.label, color: color.moveUpInk },
  detail: { ...type.caption, color: color.textSecondary },
});
