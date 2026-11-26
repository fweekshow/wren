// Add cash: dollars (USDC) in the person's own Wren account. Pick an amount,
// tap Pay, then choose Apple Pay (through Coinbase) or card (through Privy)
// on the Pay card. Cash pays for Buy and Send with no card cost.
// Same layout as every screen: top bar, headline 12px below, one blue pill.

import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, layout, spacing, type } from '../theme';
import { HeaderBack } from '../components/HeaderBack';
import { BigNumber } from '../components/BigNumber';
import { Presets } from '../components/Presets';
import { applyKey, Keypad } from '../components/Keypad';
import { Button } from '../components/Button';
import { PinnedAction } from '../components/PinnedAction';
import { PayCard } from '../components/PayCard';
import { copy } from '../copy';
import { usd2 } from '../fees';

type Props = {
  initialAmount?: number;
  onBack: () => void;
  onAdded: (cash: number) => void;
};

export function AddCashScreen({ initialAmount, onBack, onAdded }: Props) {
  const [amount, setAmount] = useState(initialAmount ? String(initialAmount) : '');
  const [paying, setPaying] = useState(false);
  const numeric = Number(amount) || 0;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <HeaderBack onBack={onBack} />
      <View style={styles.body}>
        <Text style={styles.headline}>{copy.addCashTitle}</Text>
        <Text style={styles.sub}>{copy.addCashBody}</Text>
        <View style={styles.amount}>
          <BigNumber value={numeric} size="amount" align="left" cents={amount.includes('.')} />
        </View>
      </View>
      <Presets value={amount} onChange={(v) => setAmount(String(v))} style={{ marginTop: 8 }} />
      <View style={styles.keypad}>
        <Keypad keyHeight={50} onKey={(k) => setAmount((a) => applyKey(a, k))} />
      </View>
      <PinnedAction>
        <View style={styles.actions}>
          <Text style={styles.note}>{copy.addCashNote}</Text>
          <Button disabled={!(numeric > 0)} onPress={() => setPaying(true)}>
            {numeric > 0 ? `${copy.addCashButton} ${usd2(numeric)}` : copy.addCashButton}
          </Button>
        </View>
      </PinnedAction>
      <PayCard
        visible={paying}
        amount={numeric}
        onClose={() => setPaying(false)}
        onPaid={(cash) => {
          setPaying(false);
          onAdded(cash);
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.canvas },
  body: { paddingHorizontal: spacing.screenPad, paddingTop: layout.titleGap },
  headline: { ...type.headline, color: color.ink },
  sub: { ...type.bodyRegular, color: color.textSecondary, marginTop: 14 },
  amount: { marginTop: 24, height: 92, justifyContent: 'center' },
  keypad: { paddingHorizontal: 32, paddingTop: 12 },
  actions: { gap: 10 },
  note: { ...type.caption, color: color.textSecondary, textAlign: 'center' },
});
