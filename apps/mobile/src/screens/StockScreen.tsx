// Stock page: name, ticker, price, change for the range, the chart with
// 1D · 1W · 1M · 1Y, then You hold / You sent. Buy | Send pinned.
// Prices come from Wren's own history (Chainlink on Base); markets close at
// night and on weekends, so the line goes flat then, like any stock chart.

import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, font, layout, radius, spacing, type } from '../theme';
import { HeaderBack } from '../components/HeaderBack';
import { BigNumber } from '../components/BigNumber';
import { Button } from '../components/Button';
import { Card, Change, Chart, Letter } from '../components/Market';
import { getActivity, getHistory, getPortfolio, getStocks, History, Range, Stock } from '../api';
import { copy } from '../copy';
import { usd2 } from '../fees';
import { ticker } from '../format';

const RANGES: Range[] = ['1D', '1W', '1M', '1Y'];

type Props = {
  stock: Stock;
  onBack: () => void;
  onBuy: () => void;
  onSend: () => void;
};

export function StockScreen({ stock, onBack, onBuy, onSend }: Props) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [range, setRange] = useState<Range>('1D');
  const [history, setHistory] = useState<History | null>(null);
  const [held, setHeld] = useState<number | null>(null);
  const [sent, setSent] = useState(0);

  useEffect(() => {
    let alive = true;
    getHistory(stock.symbol, range)
      .then((h) => alive && setHistory(h))
      .catch(() => alive && setHistory(null));
    return () => {
      alive = false;
    };
  }, [stock.symbol, range]);

  useEffect(() => {
    void (async () => {
      const catalog = await getStocks().catch(() => [stock]);
      const p = await getPortfolio(catalog).catch(() => null);
      setHeld(p?.holdings.find((h) => h.symbol === stock.symbol)?.value ?? 0);
      const a = await getActivity().catch(() => []);
      setSent(
        a
          .filter((x) => x.symbol === stock.symbol && x.state !== 'failed' && x.state !== 'returned')
          .reduce((s, x) => s + x.usd, 0),
      );
    })();
  }, [stock]);

  const values = (history?.points ?? []).map((p) => p[1]);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <HeaderBack onBack={onBack} />
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.head}>
          <Letter name={stock.name} size={48} bg={color.card} />
          <View>
            <Text style={styles.name}>{stock.name}</Text>
            <Text style={styles.ticker}>{ticker(stock.symbol)}</Text>
          </View>
        </View>
        <BigNumber value={history?.priceUsd ?? 0} align="left" style={{ marginTop: 20 }} />
        <View style={styles.changeRow}>
          <Change value={history?.changePct} />
          <Text style={styles.caption}>{copy.rangeWord[range]}</Text>
        </View>
        <View style={styles.chart}>
          {values.length > 1 ? (
            <Chart values={values} width={width - spacing.screenPad * 2} />
          ) : (
            <Text style={styles.caption}>{history ? copy.noChart : ''}</Text>
          )}
        </View>
        <View style={styles.ranges}>
          {RANGES.map((r) => (
            <Pressable
              key={r}
              onPress={() => setRange(r)}
              accessibilityRole="button"
              accessibilityState={{ selected: r === range }}
              style={[styles.range, r === range && styles.rangeOn]}
            >
              <Text style={[styles.rangeText, r === range && { color: color.textOnAction }]}>{r}</Text>
            </Pressable>
          ))}
        </View>
        <Card style={{ marginTop: 24 }}>
          <View style={[styles.line, sent > 0 && styles.hair]}>
            <Text style={styles.body}>{copy.youHold}</Text>
            {held != null && held > 0 ? (
              <Text style={styles.price}>{usd2(held)}</Text>
            ) : (
              <Text style={styles.none}>{held == null ? '' : copy.noneYet}</Text>
            )}
          </View>
          {sent > 0 && (
            <View style={styles.line}>
              <Text style={styles.body}>{copy.youSent}</Text>
              <Text style={styles.price}>{usd2(sent)}</Text>
            </View>
          )}
        </Card>
      </ScrollView>
      <View style={[styles.pinned, { paddingBottom: Math.max(insets.bottom, spacing.homeIndicator) }]}>
        <Button variant="secondary" onPress={onBuy} style={{ flex: 1 }}>
          {copy.buy}
        </Button>
        <Button onPress={onSend} style={{ flex: 2 }}>
          {copy.send}
        </Button>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.canvas },
  scroll: { paddingHorizontal: spacing.screenPad, paddingTop: layout.titleGap, paddingBottom: 140 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  name: { ...type.body, color: color.ink },
  ticker: { ...type.ticker, color: color.textSecondary },
  changeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  caption: { ...type.caption, color: color.textSecondary },
  chart: { marginTop: 28, height: 180, justifyContent: 'center' },
  ranges: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12 },
  range: { height: 32, minWidth: 64, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  rangeOn: { backgroundColor: color.ink },
  rangeText: { fontFamily: font.monoMedium, fontSize: 12, color: color.ink },
  line: { minHeight: 56, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  hair: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.hairline },
  body: { ...type.body, color: color.ink },
  price: { ...type.price, color: color.ink },
  none: { ...type.body, color: color.textSecondary },
  pinned: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: 16,
    paddingHorizontal: spacing.screenPad,
    backgroundColor: color.canvas,
    flexDirection: 'row',
    gap: 10,
  },
});
