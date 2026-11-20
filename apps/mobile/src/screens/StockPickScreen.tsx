// What are you sending (or buying)? The first step of Send and Buy.
// A search field, then every stock as a wallet card in its own color:
// yours first, then all. A virtualized list, so 100+ stocks stay quick.

import React, { useEffect, useMemo, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, layout, spacing, stackColors, StockColor, stockColor, type } from '../theme';
import { HeaderBack } from '../components/HeaderBack';
import { SearchField } from '../components/SearchField';
import { SectionLabel, WalletCard } from '../components/Market';
import { EmptyCard } from './ActivityScreen';
import { getMarket, getPortfolio, getStocks, MarketItem, Stock } from '../api';
import { copy } from '../copy';
import { usd2 } from '../fees';
import { ticker } from '../format';

type Props = {
  purpose: 'send' | 'buy' | 'browse';
  onBack: () => void;
  onPick: (stock: Stock) => void;
};

type Row =
  | { kind: 'label'; key: string; text: string }
  | { kind: 'stock'; key: string; stock: Stock; first: boolean; owned?: number; colors?: StockColor };

/** Give each stock row its color, with no two touching cards the same. */
function withColors(rows: Row[]): Row[] {
  const out: Row[] = [];
  let run: Extract<Row, { kind: 'stock' }>[] = [];
  const flush = () => {
    const cs = stackColors(run.map((r) => stockColor(r.stock.symbol)));
    run.forEach((r, i) => out.push({ ...r, colors: cs[i] }));
    run = [];
  };
  for (const r of rows) {
    if (r.kind === 'label') {
      flush();
      out.push(r);
    } else run.push(r);
  }
  flush();
  return out;
}

export function StockPickScreen({ purpose, onBack, onPick }: Props) {
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [market, setMarket] = useState<Map<string, MarketItem>>(new Map());
  const [owned, setOwned] = useState<Map<string, number>>(new Map());
  const [q, setQ] = useState('');

  useEffect(() => {
    void (async () => {
      const [list, mk] = await Promise.all([
        getStocks().catch(() => [] as Stock[]),
        getMarket().catch(() => [] as MarketItem[]),
      ]);
      setStocks(list);
      setMarket(new Map(mk.map((m) => [m.symbol, m] as const)));
      const p = await getPortfolio(list).catch(() => null);
      if (p) setOwned(new Map(p.holdings.map((h) => [h.symbol, h.value] as const)));
    })();
  }, []);

  const rows = useMemo<Row[]>(() => {
    const query = q.trim().toLowerCase();
    if (query) {
      const hits = stocks.filter(
        (s) => s.name.toLowerCase().includes(query) || ticker(s.symbol).toLowerCase().includes(query),
      );
      return withColors(
        hits.map((s, i) => ({ kind: 'stock', key: s.symbol, stock: s, first: i === 0, owned: owned.get(s.symbol) })),
      );
    }
    const mine = stocks.filter((s) => (owned.get(s.symbol) ?? 0) > 0).sort((a, b) => (owned.get(b.symbol) ?? 0) - (owned.get(a.symbol) ?? 0));
    const rest = stocks.filter((s) => !((owned.get(s.symbol) ?? 0) > 0));
    const out: Row[] = [];
    if (mine.length) {
      out.push({ kind: 'label', key: 'l-yours', text: copy.yoursLabel });
      mine.forEach((s, i) => out.push({ kind: 'stock', key: s.symbol, stock: s, first: i === 0, owned: owned.get(s.symbol) }));
      out.push({ kind: 'label', key: 'l-all', text: copy.allStocks });
    }
    rest.forEach((s, i) => out.push({ kind: 'stock', key: s.symbol, stock: s, first: i === 0 }));
    return withColors(out);
  }, [q, stocks, owned]);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <HeaderBack onBack={onBack} />
      <FlatList
        data={rows}
        keyExtractor={(r) => r.key}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={styles.list}
        initialNumToRender={12}
        windowSize={7}
        ListHeaderComponent={
          <View>
            <Text style={styles.title}>{purpose === 'send' ? copy.whatSending : purpose === 'buy' ? copy.whatBuying : copy.allStocks}</Text>
            <SearchField value={q} onChange={setQ} placeholder={copy.searchStocks} style={{ marginTop: 20 }} />
            <View style={{ height: 20 }} />
          </View>
        }
        ListEmptyComponent={
          q.trim() ? <EmptyCard>{copy.noStockMatch(q.trim())}</EmptyCard> : undefined
        }
        renderItem={({ item }) =>
          item.kind === 'label' ? (
            <View style={styles.label}>
              <SectionLabel>{item.text}</SectionLabel>
            </View>
          ) : (
            <WalletCard
              first={item.first}
              colors={item.colors ?? stockColor(item.stock.symbol)}
              name={item.stock.name}
              tickerText={ticker(item.stock.symbol)}
              value={market.get(item.stock.symbol)?.priceUsd ? usd2(market.get(item.stock.symbol)!.priceUsd!) : ''}
              change={item.owned ? undefined : market.get(item.stock.symbol)?.changePct}
              footer={item.owned ? copy.youOwn(usd2(item.owned)) : undefined}
              onPress={() => onPick(item.stock)}
            />
          )
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.canvas },
  list: { paddingHorizontal: 16, paddingTop: layout.titleGap, paddingBottom: 60 },
  title: { ...type.headline, color: color.ink, paddingHorizontal: spacing.screenPad - 16 },
  label: { paddingHorizontal: spacing.screenPad - 16, paddingTop: 20, paddingBottom: 12 },
});
