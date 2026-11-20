// Profile: a face, the name, "Has Wren" and Notify. What they hold as shares
// of their account (never dollars), only if they share with you. Between you:
// your sends to each other. Send pinned.

import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, font, layout, radius, spacing, type } from '../theme';
import { HeaderBack } from '../components/HeaderBack';
import { Avatar } from '../components/Avatar';
import { Button } from '../components/Button';
import { PinnedAction } from '../components/PinnedAction';
import { Icon } from '../components/Icon';
import { Card, rowLine, SectionLabel } from '../components/Market';
import { EmptyCard } from './ActivityScreen';
import { getProfile, getStocks, Profile, setNotify, Stock } from '../api';
import { copy } from '../copy';
import { formatPhone, ticker, usdShort, when } from '../format';

type Props = {
  phone: string;
  fallbackName?: string;
  onBack: () => void;
  onSend: (p: { name: string; phone: string }) => void;
};

export function ProfileScreen({ phone, fallbackName, onBack, onSend }: Props) {
  const [p, setP] = useState<Profile | null>(null);
  const [failed, setFailed] = useState(false);
  const [stocks, setStocks] = useState<Stock[]>([]);

  useEffect(() => {
    getProfile(phone)
      .then(setP)
      .catch(() => setFailed(true));
    getStocks()
      .then(setStocks)
      .catch(() => undefined);
  }, [phone]);

  // Name from where you tapped, so the page never flashes the number as a name.
  const name = p?.name ?? fallbackName ?? formatPhone(phone);
  const first = name.split(' ')[0];
  const stockName = (sym: string) => stocks.find((s) => s.symbol === sym)?.name ?? ticker(sym);

  const toggleNotify = () => {
    if (!p) return;
    const next = !p.notify;
    setP({ ...p, notify: next });
    void setNotify(phone, next).catch(() => setP((cur) => (cur ? { ...cur, notify: !next } : cur)));
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <HeaderBack onBack={onBack} />
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.head}>
          <Avatar name={name} size={96} />
          <Text style={styles.name} numberOfLines={1} adjustsFontSizeToFit>
            {first}
          </Text>
          <Text style={styles.phone}>{formatPhone(phone)}</Text>
          {p?.hasWren && (
            <View style={styles.hasWren}>
              <View style={styles.dot} />
              <Text style={styles.caption}>{copy.hasWren}</Text>
            </View>
          )}
          {p?.hasWren && p.canSeeMoves && (
            <Pressable
              onPress={toggleNotify}
              accessibilityRole="switch"
              accessibilityState={{ checked: p.notify }}
              style={[styles.notify, p.notify && styles.notifyOn]}
            >
              {p.notify && <Icon name="check" size={16} color={color.textOnAction} />}
              <Text style={[styles.notifyText, p.notify && { color: color.textOnAction }]}>
                {p.notify ? copy.notifyOn : copy.notify}
              </Text>
            </Pressable>
          )}
        </View>
        {p?.notify && <Text style={[styles.caption, styles.center]}>{copy.notifyNote(first)}</Text>}

        {p && (
          <View style={{ marginTop: 36 }}>
            <SectionLabel>{p.hasWren ? copy.whatTheyHold : copy.yourStocks}</SectionLabel>
            <View style={{ marginTop: 12 }}>
              {!p.hasWren ? (
                <EmptyCard>{copy.profileNotOnWren}</EmptyCard>
              ) : !p.canSeeMoves ? (
                <EmptyCard>{copy.keepsPrivate(first)}</EmptyCard>
              ) : p.holdings.length ? (
                <>
                  <Card>
                    {p.holdings.map((h, i) => (
                      <View key={h.symbol} style={[styles.row, rowLine(i, p.holdings.length)]}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.body}>{h.name}</Text>
                          <Text style={styles.ticker}>{ticker(h.symbol)}</Text>
                        </View>
                        <Text style={styles.pct}>{h.pct}%</Text>
                      </View>
                    ))}
                  </Card>
                  <Text style={[styles.caption, { marginTop: 10 }]}>{copy.shareNote}</Text>
                </>
              ) : (
                <EmptyCard>{copy.noneYet}</EmptyCard>
              )}
            </View>
          </View>
        )}
        {failed && !p && (
          <View style={{ marginTop: 36 }}>
            <EmptyCard>{copy.couldntLoad}</EmptyCard>
          </View>
        )}

        {p && p.between.length > 0 && (
          <View style={{ marginTop: 32 }}>
            <SectionLabel>{copy.betweenYou}</SectionLabel>
            <Card style={{ marginTop: 12 }}>
              {p.between.map((b, i) => {
                const what = copy.sendWhat(b.usd != null ? usdShort(b.usd) : '', stockName(b.symbol)).trim();
                return (
                  <View key={`${b.at}-${i}`} style={[styles.between, rowLine(i, p.between.length)]}>
                    <Text style={[styles.body, { flex: 1 }]} numberOfLines={1}>
                      {b.from === 'you' ? copy.youSentThem(what) : copy.theySentYou(first, what)}
                    </Text>
                    <Text style={styles.when}>{when(b.at)}</Text>
                  </View>
                );
              })}
            </Card>
          </View>
        )}
      </ScrollView>
      <PinnedAction>
        <Button onPress={() => onSend({ name, phone })}>{copy.send}</Button>
      </PinnedAction>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.canvas },
  scroll: { paddingHorizontal: spacing.screenPad, paddingTop: layout.titleGap, paddingBottom: 140 },
  head: { alignItems: 'center', gap: 14 },
  name: { ...type.name, color: color.ink },
  hasWren: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: color.wrenBody },
  caption: { ...type.caption, color: color.textSecondary },
  phone: { ...type.price, color: color.textSecondary, marginTop: -6 },
  center: { textAlign: 'center', marginTop: 12 },
  notify: {
    height: 40,
    paddingHorizontal: 18,
    borderRadius: radius.pill,
    backgroundColor: color.card,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  notifyOn: { backgroundColor: color.ink },
  notifyText: { fontFamily: font.uiSemiBold, fontSize: 15, color: color.ink },
  row: { minHeight: 72, paddingHorizontal: 20, paddingVertical: 12, flexDirection: 'row', alignItems: 'center' },
  body: { ...type.body, color: color.ink },
  ticker: { ...type.ticker, color: color.textSecondary, marginTop: 2 },
  pct: { ...type.price, color: color.ink },
  between: { minHeight: 60, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', gap: 12 },
  when: { ...type.caption, color: color.textTertiary },
});
