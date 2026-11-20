// Activity: every stock you sent and where it is. Only you see this.
// Wren Bold: a 52px headline, open rows (no card), a face, "Maya" over
// "$50 of Apple · 2h", and where it is as a pill on the right.

import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, font, layout, radius, spacing, stockColor, type } from '../theme';
import { HeaderBack } from '../components/HeaderBack';
import { Avatar } from '../components/Avatar';
import { Button } from '../components/Button';
import { PinnedAction } from '../components/PinnedAction';
import { Card, rowLine } from '../components/Market';
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

/** In their account reads as good news in Wren's people blue; the rest stay gray. */
function StatePill({ a }: { a: ActivityItem }) {
  const good = a.state === 'in_account';
  const bought = a.state === 'bought';
  return (
    <View style={[styles.pill, good && { backgroundColor: color.wrenTint }, bought && { backgroundColor: color.lime }]}>
      <Text style={[styles.pillText, good && { color: color.wrenWing }]} numberOfLines={1}>
        {stateLabel(a)}
      </Text>
    </View>
  );
}

export function ActivityRows({
  items,
  onOpen,
}: {
  items: ActivityItem[];
  onOpen?: (a: ActivityItem) => void;
}) {
  return (
    <View>
      {items.map((a, i) => {
        const buy = a.kind === 'buy';
        const name = buy ? copy.youBought : (a.name ?? a.phone ?? copy.someone);
        const sc = stockColor(a.symbol);
        return (
          <Pressable
            key={a.id}
            disabled={!onOpen || (!a.phone && !buy)}
            onPress={() => onOpen?.(a)}
            style={[styles.row, rowLine(i, items.length)]}
          >
            {buy ? (
              <View style={[styles.badge, { backgroundColor: sc.bg }]}>
                <Text style={[styles.badgeText, { color: sc.ink }]}>{a.stockName.slice(0, 1)}</Text>
              </View>
            ) : (
              <Avatar name={name} size={48} />
            )}
            <View style={styles.mid}>
              <Text style={styles.name} numberOfLines={1}>
                {name}
              </Text>
              <Text style={styles.what} numberOfLines={1}>
                {copy.sendWhat(usdShort(a.usd), a.stockName)} · {when(a.at)}
              </Text>
            </View>
            <StatePill a={a} />
          </Pressable>
        );
      })}
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
  pill: {
    height: 32,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
    backgroundColor: color.card,
    justifyContent: 'center',
    maxWidth: 150,
  },
  pillText: { fontFamily: font.uiSemiBold, fontSize: 13, color: color.ink },
  badge: { width: 54, height: 54, borderRadius: 27, alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontFamily: font.display, fontSize: 22 },
  empty: { paddingVertical: 22, paddingHorizontal: 20, gap: 14 },
  emptyText: { ...type.body, color: color.textSecondary },
});
