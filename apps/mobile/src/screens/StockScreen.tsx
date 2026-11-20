// Stock page (Wren Bold): the name as the headline, the price at balance
// size, change for the range, a bold chart with 1D · 1W · 1M · 1Y, then
// You hold / You sent as tiles. Buy | Send pinned.
// Prices come from Wren's own history (Chainlink on Base); markets close at
// night and on weekends, so the line goes flat then, like any stock chart.

import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, layout, spacing, type } from '../theme';
import { HeaderBack } from '../components/HeaderBack';
import { BigNumber } from '../components/BigNumber';
import { Button } from '../components/Button';
import { Change, Chart, Segmented, StockTile } from '../components/Market';
import { getActivity, getHistory, getPortfolio, getStocks, History, Range, Stock } from '../api';
import { copy } from '../copy';
import { usd2 } from '../fees';
import { chartTime, ticker } from '../format';

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
  const [sent, setSent] = useState({ usd: 0, count: 0 });

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
      const mine = a.filter((x) => x.symbol === stock.symbol && x.state !== 'failed' && x.state !== 'returned');
      setSent({ usd: mine.reduce((s, x) => s + x.usd, 0), count: mine.length });
    })();
  }, [stock]);

  const points = history?.points ?? [];
  const values = points.map((p) => p[1]);
  const [scrub, setScrub] = useState<number | null>(null);
  const touching = scrub != null && scrub < values.length && values.length > 1;
  const shownPrice = touching ? values[scrub] : (history?.priceUsd ?? 0);
  const shownChange = touching
    ? values[0] > 0
      ? ((values[scrub] - values[0]) / values[0]) * 100
      : null
    : history?.changePct;
  const shownWhen = touching ? chartTime(points[scrub][0], range) : copy.rangeWord[range];

  const tileW = (width - spacing.screenPad * 2 - 10) / 2;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <HeaderBack onBack={onBack} />
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false} scrollEnabled={!touching}>
        <Text style={styles.name} numberOfLines={1} adjustsFontSizeToFit>
          {stock.name}
        </Text>
        <Text style={styles.ticker}>{ticker(stock.symbol)}</Text>
         <BigNumber value={shownPrice} size="balance" align="left" style={{ marginTop: 20 }} />
        <View style={styles.changeRow}>
          <Change value={shownChange} />
          <Text style={styles.caption}>{shownWhen}</Text>
        </View>
        <View style={styles.chart}>
          {values.length > 1 ? (
            <Chart values={values} width={width - spacing.screenPad * 2} height={CHART_H} onScrub={setScrub} />
          ) : (
            <Text style={styles.caption}>{history ? copy.noChart : ''}</Text>
          )}
        </View>
        <Segmented
          fill
          value={range}
          onChange={setRange}
          options={RANGES.map((r) => ({ value: r, label: r }))}
          style={{ marginTop: 16 }}
        />
        <View style={styles.tiles}>
          <StockTile
            width={tileW}
            blue={!!held && held > 0}
            name={copy.youHold}
            tickerText={ticker(stock.symbol)}
            value={held == null ? '' : usd2(held)}
            footer={held == null ? ' ' : held > 0 ? copy.readyToSend : copy.noneYet}
          />
          <StockTile
            width={tileW}
            name={copy.youSent}
            tickerText=""
            value={usd2(sent.usd)}
            footer={sent.count ? copy.sendsCount(sent.count) : copy.nothingSent}
          />
        </View>
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

const CHART_H = 220;

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.canvas },
  scroll: { paddingHorizontal: spacing.screenPad, paddingTop: layout.titleGap, paddingBottom: 140 },
  name: { ...type.headline, color: color.ink },
  ticker: { ...type.ticker, color: color.textSecondary, marginTop: 8 },
  changeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  caption: { ...type.caption, color: color.textSecondary },
  chart: { marginTop: 24, height: CHART_H, justifyContent: 'center' },
  tiles: { flexDirection: 'row', gap: 10, marginTop: 24 },
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
