// The account. The total is the headline, stocks underneath, one Send pill.
// Send is the product: a stock goes to someone you know, from here.
// An empty account still lists the stocks you can send.
// Not connected yet → a gray bubble from Wren that opens Connect.

import React, { useCallback, useEffect, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, spacing, type } from '../theme';
import { copy } from '../copy';
import { getConnectState, getPortfolio, getStocks, Portfolio, Stock } from '../api';
import { BubbleCard } from '../components/BubbleCard';
import { BigNumber } from '../components/BigNumber';
import { StockList, StockRow } from '../components/StockRow';
import { PinnedAction } from '../components/PinnedAction';
import { Button } from '../components/Button';

const STOCKS: Stock[] = [
  { symbol: 'AAPL', name: 'Apple' },
  { symbol: 'NVDA', name: 'NVIDIA' },
  { symbol: 'TSLA', name: 'Tesla' },
  { symbol: 'MSFT', name: 'Microsoft' },
];

type Props = {
  onSend: () => void;
  onConnect: () => void;
};

export function HomeScreen({ onSend, onConnect }: Props) {
  const [portfolio, setPortfolio] = useState<Portfolio>({ total: 0, holdings: [] });
  const [catalog, setCatalog] = useState<Stock[]>(STOCKS);
  const [refreshing, setRefreshing] = useState(false);
  const [needsConnect, setNeedsConnect] = useState(false);

  const load = useCallback(async () => {
    try {
      setPortfolio(await getPortfolio());
    } catch {
      // Keep the last total. Send stays either way.
    }
    try {
      const stocks = await getStocks();
      if (stocks.length) setCatalog(stocks);
    } catch {
      // The four names above are the account until the server answers.
    }
    try {
      const connect = await getConnectState();
      setNeedsConnect(!connect.imessageOptedInAt && !connect.whatsappOptedInAt);
    } catch {
      // Connecting is optional until the server answers.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const held = portfolio.holdings.length > 0;
  const rows = held ? portfolio.holdings : catalog;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.hero}>
          <BigNumber value={portfolio.total} align="left" />
          <Text style={styles.why}>{copy.homeWhy}</Text>
        </View>

        {needsConnect ? (
          <Pressable
            onPress={onConnect}
            accessibilityRole="button"
            style={({ pressed }) => [styles.connect, pressed && styles.pressed]}
          >
            <BubbleCard from="them">{copy.homeConnect}</BubbleCard>
          </Pressable>
        ) : null}

        <Text style={styles.section}>{copy.homeStocks}</Text>
        <View style={styles.list}>
          <StockList>
            {rows.map((row, i) => (
              <StockRow
                key={row.symbol}
                name={row.name}
                symbol={row.symbol}
                value={'value' in row ? (row as { value: number }).value : undefined}
                last={i === rows.length - 1}
                onPress={onSend}
              />
            ))}
          </StockList>
        </View>
      </ScrollView>
      <PinnedAction>
        <Button onPress={onSend}>{copy.homeSend}</Button>
      </PinnedAction>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.canvas },
  scroll: {
    flexGrow: 1,
    paddingBottom: 140,
  },
  hero: {
    paddingHorizontal: spacing.screenPad,
    paddingTop: 32,
  },
  why: {
    ...type.bodyRegular,
    color: color.textSecondary,
    marginTop: 14,
  },
  connect: {
    paddingHorizontal: spacing.screenPad,
    marginTop: 28,
  },
  pressed: { transform: [{ scale: 0.98 }] },
  section: {
    ...type.label,
    color: color.textSecondary,
    marginTop: 36,
    marginBottom: 8,
    paddingHorizontal: spacing.screenPad,
  },
  list: {
    paddingHorizontal: spacing.screenPad,
  },
});
