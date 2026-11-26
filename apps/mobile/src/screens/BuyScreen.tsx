// Buy: the amount screen without a person. Spends cash in your Wren account;
// no Wren fee. Not enough cash → "You have $20 in cash. Add $30 to buy this."
// and the button becomes Pay $31: the Pay card adds the cash (Apple Pay or
// card), then the buy goes through with the same stock and amount.

import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, spacing, type } from '../theme';
import { HeaderBack } from '../components/HeaderBack';
import { BigNumber } from '../components/BigNumber';
import { ChosenStock } from '../components/Market';
import { Presets } from '../components/Presets';
import { applyKey, Keypad } from '../components/Keypad';
import { Button } from '../components/Button';
import { PayCard, topUpFor } from '../components/PayCard';
import { FeesLine } from '../components/FeesLine';
import { buyStock, BuyResult, getPortfolio, getStocks, notEnoughCash, Stock } from '../api';
import { copy } from '../copy';
import { usd2 } from '../fees';
import { track } from '../observe';

type Props = {
  initialSymbol?: string;
  onBack: () => void;
  onBought: (r: BuyResult & { stockName: string }) => void;
  onChangeStock: () => void;
};

export function BuyScreen({ initialSymbol, onBack, onBought, onChangeStock }: Props) {
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [symbol, setSymbol] = useState<string | undefined>(initialSymbol);
  useEffect(() => {
    if (initialSymbol) setSymbol(initialSymbol);
  }, [initialSymbol]);
  const [amount, setAmount] = useState('');
  const [cash, setCash] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [short, setShort] = useState<{ cashUsd: number; neededUsd: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);

  useEffect(() => {
    void (async () => {
      const list = await getStocks().catch(() => [] as Stock[]);
      setStocks(list);
      setSymbol((s) => s ?? list[0]?.symbol);
      const p = await getPortfolio(list).catch(() => null);
      if (p) setCash(p.cash);
    })();
  }, []);

  const numeric = useMemo(() => Number(amount) || 0, [amount]);
  const stockName = stocks.find((s) => s.symbol === symbol)?.name ?? '';

  const edit = (fn: (s: string) => string) => {
    setShort(null);
    setError(null);
    setAmount(fn);
  };

  const buy = async () => {
    if (!symbol || !(numeric > 0)) return;
    setBusy(true);
    setError(null);
    track('buy_started', { symbol, from: 'cash' });
    try {
      const r = await buyStock(symbol, numeric);
      track('buy_succeeded', { symbol });
      onBought({ ...r, stockName });
    } catch (err) {
      const s = notEnoughCash(err);
      if (s) setShort(s);
      else setError(copy.didntGo);
    } finally {
      setBusy(false);
    }
  };

  // Ask for cash before the tap when we already know it's short.
  const knownShort = cash != null && numeric > 0 && numeric > cash + 0.005;
  const shortBy = short ? short.neededUsd - short.cashUsd : knownShort ? numeric - (cash ?? 0) : 0;
  const needsCash = !!short || knownShort;
  const topUp = topUpFor(Math.max(shortBy, 0.01));

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <HeaderBack onBack={onBack} title={copy.buyTitle} />
      <View style={styles.hero}>
        <View style={styles.amount}>
          <BigNumber value={numeric} size="amount" cents={amount.includes('.')} />
        </View>
      </View>
      {symbol ? (
        <ChosenStock
          name={stockName || symbol.replace(/c$/, '')}
          symbol={symbol}
          onChange={onChangeStock}
          style={{ marginTop: 8, marginHorizontal: 16 }}
        />
      ) : null}
      <Presets value={amount} onChange={(v) => edit(() => String(v))} style={{ marginTop: 16 }} />
      <View style={styles.keypad}>
        <Keypad keyHeight={50} onKey={(k) => edit((a) => applyKey(a, k))} />
      </View>
      <View style={styles.footer}>
        {error ? (
          <Text style={styles.note}>{error}</Text>
        ) : needsCash ? (
          <Text style={styles.note}>
            {copy.notEnoughCash(usd2(short?.cashUsd ?? cash ?? 0), usd2(Math.max(shortBy, 0.01)))}
          </Text>
        ) : numeric > 0 ? (
          <FeesLine totalUsd={numeric} fees={[]} freeNote={copy.fromYourCash} />
        ) : cash != null ? (
          <Text style={styles.note}>{copy.cashHave(usd2(cash))}</Text>
        ) : null}
        {needsCash ? (
          <Button onPress={() => setPaying(true)}>{copy.addAmount(usd2(topUp))}</Button>
        ) : (
          <Button disabled={!symbol || !(numeric > 0)} loading={busy} onPress={() => void buy()}>
            {busy ? copy.buying : copy.buy}
          </Button>
        )}
      </View>
      <PayCard
        visible={paying}
        amount={topUp}
        headline={numeric}
        note={(cash ?? 0) >= 0.01 ? copy.fromCashPart(usd2(cash ?? 0)) : undefined}
        onClose={() => setPaying(false)}
        onPaid={(c) => {
          setPaying(false);
          setCash(c);
          setShort(null);
          void buy();
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.canvas },
  hero: { paddingHorizontal: spacing.screenPad, paddingTop: 16, alignItems: 'center' },
  amount: { height: 96, justifyContent: 'center' },
  keypad: { paddingHorizontal: 32, paddingTop: 12 },
  footer: {
    position: 'absolute',
    left: spacing.screenPad,
    right: spacing.screenPad,
    bottom: spacing.homeIndicator,
    gap: 12,
  },
  note: { ...type.caption, color: color.textSecondary, textAlign: 'center' },
});
