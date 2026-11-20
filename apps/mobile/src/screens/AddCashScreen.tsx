// Add cash: dollars (USDC) in the person's own Wren account, added with
// Apple Pay or a card through Privy's funding sheet (Coinbase preferred, for
// Apple Pay). Cash pays for Buy and Send with no card cost.
// Same layout as every screen: top bar, headline 12px below, one blue pill.

import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFundWallet } from '@privy-io/expo/ui';
import { base } from 'viem/chains';
import { color, layout, spacing, type } from '../theme';
import { HeaderBack } from '../components/HeaderBack';
import { BigNumber } from '../components/BigNumber';
import { Presets } from '../components/Presets';
import { applyKey, Keypad } from '../components/Keypad';
import { Button } from '../components/Button';
import { PinnedAction } from '../components/PinnedAction';
import { copy } from '../copy';
import { track } from '../observe';

type Props = {
  address: string | null;
  onBack: () => void;
  onAdded: () => void;
};

export function AddCashScreen({ address, onBack, onAdded }: Props) {
  const { fundWallet } = useFundWallet();
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const numeric = Number(amount) || 0;

  const add = async () => {
    if (!address || !(numeric > 0)) return;
    setBusy(true);
    setError(null);
    track('add_cash_started', { amount: numeric });
    try {
      await fundWallet({
        address,
        chain: base,
        asset: 'USDC',
        amount: numeric.toFixed(2),
        card: { preferredProvider: 'coinbase' },
      });
      track('add_cash_finished', { amount: numeric });
      onAdded();
    } catch {
      setError(copy.didntGo);
    } finally {
      setBusy(false);
    }
  };

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
          {error ? <Text style={styles.error}>{error}</Text> : <Text style={styles.note}>{copy.addCashNote}</Text>}
          <Button disabled={!address || !(numeric > 0)} loading={busy} onPress={() => void add()}>
            {copy.addCashButton}
          </Button>
        </View>
      </PinnedAction>
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
  error: { ...type.caption, color: color.ink, textAlign: 'center' },
});
