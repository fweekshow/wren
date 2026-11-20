// Activity: every stock you sent and where it is. Only you see this.
// Wren Bold: a 52px headline, open rows (no card), a face, "Maya" over
// "$50 of Apple · 2h", and where it is as a pill on the right.

import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, font, layout, radius, spacing, stackColors, stockColor, type } from '../theme';
import { HeaderBack } from '../components/HeaderBack';
import { Avatar } from '../components/Avatar';
import { Button } from '../components/Button';
import { PinnedAction } from '../components/PinnedAction';
import { Card, SectionLabel } from '../components/Market';
import { ActivityItem, getActivity } from '../api';
import { copy } from '../copy';
import { usdShort, when } from '../format';

export function stateLabel(a: ActivityItem): string {
  const first = (a.name ?? '').split(' ')[0] || copy.someone;
  switch (a.state) {
    case 'sending':
      return copy.stateSending;
    case 'in_account':
      return copy.stateInAccount;
    case 'waiting':
      return copy.stateWaiting(first);
    case 'returned':
      return copy.stateReturned;
    case 'bought':
      return copy.stateBought;
    default:
      return copy.stateFailed;
  }
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const TUCK = 28;

/**
 * Wren Color (A + C): every send and buy is a card in its stock's color,
 * stacked like a wallet and grouped This week / Earlier. Who and how much on
 * the left; where it is as a white pill on the right.
 */
export function ActivityRows({
  items,
  onOpen,
}: {
  items: ActivityItem[];
  onOpen?: (a: ActivityItem) => void;
}) {
  const now = Date.now();
  const groups = [
    { label: copy.thisWeek, items: items.filter((a) => now - Date.parse(a.at) < WEEK_MS) },
    { label: copy.earlier, items: items.filter((a) => now - Date.parse(a.at) >= WEEK_MS) },
  ]
    .filter((g) => g.items.length)
    .map((g) => ({ ...g, colors: stackColors(g.items.map((a) => stockColor(a.symbol))) }));
  return (
    <View>
      {groups.map((g, gi) => (
        <View key={g.label} style={{ marginTop: gi ? 24 : 0 }}>
          <SectionLabel>{g.label}</SectionLabel>
          <View style={{ marginTop: 12 }}>
            {g.items.map((a, i) => {
              const buy = a.kind === 'buy';
              const title = buy ? copy.youBought : (a.name ?? a.phone ?? copy.someone);
              const sc = g.colors[i];
              return (
                <Pressable
                  key={a.id}
                  disabled={!onOpen || (!a.phone && !buy)}
                  onPress={() => onOpen?.(a)}
                  accessibilityRole="button"
                  accessibilityLabel={`${title}, ${copy.sendWhat(usdShort(a.usd), a.stockName)}, ${stateLabel(a)}`}
                  style={({ pressed }) => [
                    styles.card,
                    { backgroundColor: sc.bg, marginTop: i ? -TUCK : 0 },
                    pressed && { transform: [{ scale: 0.98 }] },
                  ]}
                >
                  <View style={styles.mid}>
                    <Text style={[styles.cardTitle, { color: sc.ink }]} numberOfLines={1}>
                      {title}
                    </Text>
                    <Text style={[styles.cardWhat, { color: sc.ink }]} numberOfLines={1}>
                      {copy.sendWhat(usdShort(a.usd), a.stockName)} · {when(a.at)}
                    </Text>
                  </View>
                  <View style={styles.pill}>
                    <Text style={styles.pillText} numberOfLines={1}>
                      {stateLabel(a)}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        </View>
      ))}
    </View>
  );
}

export function EmptyCard({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <Card style={styles.empty}>
      <Text style={styles.emptyText}>{children}</Text>
      {action}
    </Card>
  );
}

type Props = {
  onBack: () => void;
  onSend: () => void;
  onOpenPerson: (phone: string, name?: string) => void;
};

export function ActivityScreen({ onBack, onSend, onOpenPerson }: Props) {
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems(await getActivity());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <HeaderBack onBack={onBack} />
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
          />
        }
      >
        <Text style={styles.title}>{copy.activity}</Text>
        <Text style={styles.sub}>{copy.onlyYou}</Text>
        <View style={{ marginTop: 24 }}>
          {failed && !items ? (
            <EmptyCard
              action={
                <Button variant="secondary" onPress={() => void load()} style={{ alignSelf: 'flex-start' }}>
                  {copy.retry}
                </Button>
              }
            >
              {copy.couldntLoad}
            </EmptyCard>
          ) : items && items.length === 0 ? (
            <EmptyCard>{copy.noSends}</EmptyCard>
          ) : items ? (
            <ActivityRows items={items} onOpen={(a) => a.phone && onOpenPerson(a.phone, a.name ?? undefined)} />
          ) : null}
        </View>
      </ScrollView>
      <PinnedAction>
        <Button onPress={onSend}>{copy.send}</Button>
      </PinnedAction>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.canvas },
  scroll: { paddingHorizontal: spacing.screenPad, paddingTop: layout.titleGap, paddingBottom: 140 },
  title: { ...type.headline, color: color.ink },
  sub: { ...type.bodyRegular, color: color.textSecondary, marginTop: 10 },
  row: { minHeight: 80, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', gap: 12 },
  mid: { flex: 1, minWidth: 0, gap: 2 },
  name: { ...type.body, color: color.ink },
  what: { ...type.label, fontFamily: font.uiRegular, color: color.textSecondary },
  card: {
    height: 100,
    borderRadius: 30,
    borderWidth: 2,
    borderColor: color.canvas,
    paddingLeft: 20,
    paddingRight: 14,
    paddingTop: 16,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  cardTitle: { fontFamily: font.display, fontSize: 21, lineHeight: 26, letterSpacing: -0.4 },
  cardWhat: { fontFamily: font.uiRegular, fontSize: 14, lineHeight: 19, marginTop: 2, opacity: 0.85 },
  pill: {
    height: 30,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
    backgroundColor: color.canvas,
    justifyContent: 'center',
    maxWidth: 160,
  },
  pillText: { fontFamily: font.uiSemiBold, fontSize: 13, color: color.ink },
  badge: { width: 54, height: 54, borderRadius: 27, alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontFamily: font.display, fontSize: 22 },
  empty: { paddingVertical: 22, paddingHorizontal: 20, gap: 14 },
  emptyText: { ...type.body, color: color.textSecondary },
});
