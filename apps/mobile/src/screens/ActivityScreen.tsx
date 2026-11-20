// Activity: every stock you sent and where it is. Only you see this.
// Rows: "Maya · $50 of Apple" on the left; "In their account · 2h" on the right.
// The rows are shared with the Account tab, which shows the latest three.

import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, layout, spacing, type } from '../theme';
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
    default:
      return copy.stateFailed;
  }
}

export function ActivityRows({
  items,
  onOpen,
}: {
  items: ActivityItem[];
  onOpen?: (a: ActivityItem) => void;
}) {
  return (
    <Card>
      {items.map((a, i) => {
        const name = a.name ?? a.phone ?? copy.someone;
        return (
          <Pressable
            key={a.id}
            disabled={!onOpen || !a.phone}
            onPress={() => onOpen?.(a)}
            style={[styles.row, rowLine(i, items.length)]}
          >
            <Avatar name={name} size={40} />
            <View style={styles.mid}>
              <Text style={styles.name} numberOfLines={1}>
                {name}
              </Text>
              <Text style={styles.what} numberOfLines={1}>
                {copy.sendWhat(usdShort(a.usd), a.stockName)}
              </Text>
            </View>
            <View style={styles.right}>
              <Text style={styles.status} numberOfLines={1}>
                {stateLabel(a)}
              </Text>
              <Text style={styles.when}>{when(a.at)}</Text>
            </View>
          </Pressable>
        );
      })}
    </Card>
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
  onOpenPerson: (phone: string) => void;
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
            <ActivityRows items={items} onOpen={(a) => a.phone && onOpenPerson(a.phone)} />
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
  title: { ...type.title, color: color.ink },
  sub: { ...type.caption, color: color.textSecondary, marginTop: 8 },
  row: { minHeight: 76, paddingVertical: 12, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 10 },
  mid: { flex: 1, minWidth: 0 },
  name: { ...type.body, color: color.ink },
  what: { ...type.caption, color: color.textSecondary },
  right: { alignItems: 'flex-end', gap: 4, maxWidth: 150 },
  status: { ...type.caption, color: color.ink },
  when: { ...type.caption, color: color.textTertiary },
  empty: { paddingVertical: 22, paddingHorizontal: 20, gap: 14 },
  emptyText: { ...type.body, color: color.textSecondary },
});
