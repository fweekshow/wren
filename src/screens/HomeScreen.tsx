// Home: bird on top of the total, stock list below, one Send pill.
// If the portfolio call fails or returns nothing, Send stays (per spec).

import React, { useCallback, useEffect, useState } from 'react';
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, spacing } from '../theme';
import { getPortfolio, Portfolio } from '../api';
import { Wren } from '../components/Wren';
import { BigNumber } from '../components/BigNumber';
import { StockList, StockRow } from '../components/StockRow';
import { PinnedAction } from '../components/PinnedAction';
import { Button } from '../components/Button';

type Props = {
  onSend: () => void;
};

export function HomeScreen({ onSend }: Props) {
  const [portfolio, setPortfolio] = useState<Portfolio>({ total: 0, holdings: [] });
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const p = await getPortfolio();
      setPortfolio(p);
    } catch {
      // Keep whatever we had. Send stays either way.
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

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.hero}>
          <Wren size={150} style={{ marginBottom: 6 }} />
          <BigNumber value={portfolio.total} />
        </View>
        {portfolio.holdings.length > 0 && (
          <View style={styles.list}>
            <StockList>
              {portfolio.holdings.map((h, i) => (
                <StockRow
                  key={`${h.symbol}-${i}`}
                  name={h.name}
                  symbol={h.symbol}
                  value={h.value}
                  last={i === portfolio.holdings.length - 1}
                />
              ))}
            </StockList>
          </View>
        )}
      </ScrollView>
      <PinnedAction>
        <Button onPress={onSend}>Send</Button>
      </PinnedAction>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.canvas },
  scroll: {
    flexGrow: 1,
    paddingBottom: 140, // leaves room for the pinned pill
  },
  hero: {
    alignItems: 'center',
    paddingTop: 40,
  },
  list: {
    paddingHorizontal: spacing.screenPad,
    paddingTop: 56,
  },
});
