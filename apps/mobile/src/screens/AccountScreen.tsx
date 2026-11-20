// Account, the home screen. Top bar: logo · Account | People · Settings.
//
// Account tab (Wren Color): a big balance with today's change, what you own
// as a wallet stack (Cash last), what you can send as color tiles.
// Activity tab: your sends and buys, newest first. Only you see it.
// People tab: your people on Wren, their moves (only if you share yours),
// and people not on Wren yet, each with Send.
// Pinned: the channel line, then Buy | Send.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { cashColor, color, font, layout, personColor, quietColor, spacing, stackColors, gridColors, stockColor, type } from '../theme';
import { usd2 } from '../fees';
import { copy } from '../copy';
import { ticker, usdShort, when } from '../format';
import {
  ActivityItem,
  getActivity,
  getConnectState,
  getMarket,
  getMoves,
  getPeople,
  getPortfolio,
  getStocks,
  MarketItem,
  Move,
  Portfolio,
  Stock,
  WrenPerson,
} from '../api';
import { BigNumber } from '../components/BigNumber';
import { Button } from '../components/Button';
import { Avatar } from '../components/Avatar';
import { Change, PersonCard, PillButton, SectionLabel, Segmented, StockTile, WalletCard } from '../components/Market';
import { SearchField } from '../components/SearchField';
import { ActivityRows, EmptyCard } from './ActivityScreen';
import { Icon } from '../components/Icon';
import { BubbleCard } from '../components/BubbleCard';

export type HomeTab = 'account' | 'people' | 'activity';
type Tab = HomeTab;

type Props = {
  tab: Tab;
  onTab: (t: Tab) => void;
  onSend: () => void;
  onBuy: () => void;
  onOpenStock: (stock: Stock) => void;
  onSettings: () => void;
  onActivity: () => void;
  onConnect: () => void;
  onOpenPerson: (phone: string, name?: string) => void;
  onSendTo: (p: WrenPerson) => void;
};

const logo = require('../../assets/logo.png');
const TILE_GAP = 10;

/** Balance over today: cash + each stock's shares × its price along the sparkline. */
export function balanceLine(cash: number, holdings: Portfolio['holdings'], market: Map<string, MarketItem>): {
  values: number[];
  changePct: number | null;
} {
  const series = holdings
    .map((h) => {
      const m = market.get(h.symbol);
      if (!m?.priceUsd || m.spark.length < 2) return null;
      const shares = h.value / m.priceUsd;
      return m.spark.map((p) => p * shares);
    })
    .filter((s): s is number[] => !!s);
  if (!series.length) return { values: [], changePct: null };
  const n = Math.min(...series.map((s) => s.length));
  const values = Array.from({ length: n }, (_, i) =>
    series.reduce((sum, s) => sum + s[s.length - n + i], cash),
  );
  const open = values[0];
  const now = values[values.length - 1];
  return { values, changePct: open > 0 ? ((now - open) / open) * 100 : null };
}

export function AccountScreen(props: Props) {
  const { tab, onTab } = props;
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [failed, setFailed] = useState(false);
  const [market, setMarket] = useState<Map<string, MarketItem>>(new Map());
  const [activity, setActivity] = useState<ActivityItem[] | null>(null);
  const [channel, setChannel] = useState<string | null | undefined>(undefined);
  const [people, setPeople] = useState<{ onWren: WrenPerson[]; notOnWren: WrenPerson[] } | null>(null);
  const [moves, setMoves] = useState<{ sharing: boolean; items: Move[] } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [friendQ, setFriendQ] = useState('');

  const load = useCallback(async () => {
    const [catalog, mk] = await Promise.all([
      getStocks().catch(() => [] as Stock[]),
      getMarket().catch(() => [] as MarketItem[]),
    ]);
    setStocks(catalog);
    setMarket(new Map(mk.map((m) => [m.symbol, m] as const)));
    await Promise.all([
      getPortfolio(catalog)
        .then((p) => {
          setPortfolio(p);
          setFailed(false);
        })
        .catch(() => setFailed(true)),
      getActivity().then(setActivity).catch(() => undefined),
      getConnectState()
        .then((c) =>
          setChannel(c.imessageOptedInAt ? copy.iMessage : c.whatsappOptedInAt ? copy.whatsapp : null),
        )
        .catch(() => undefined),
      getPeople().then(setPeople).catch(() => undefined),
      getMoves().then(setMoves).catch(() => undefined),
    ]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const holdings = portfolio?.holdings ?? [];
  const cash = portfolio?.cash ?? 0;
  const line = useMemo(() => balanceLine(cash, holdings, market), [cash, holdings, market]);
  const contentWidth = width - spacing.screenPad * 2;

  const top = (
    <View style={styles.top}>
      <Image source={logo} style={styles.logo} accessibilityLabel="Wren" />
      <Segmented
        value={tab}
        onChange={onTab}
        options={[
          { value: 'account', label: copy.tabAccount },
          { value: 'people', label: copy.tabPeople },
          { value: 'activity', label: copy.tabActivity },
        ]}
      />
      <Pressable
        onPress={props.onSettings}
        accessibilityRole="button"
        accessibilityLabel={copy.settings}
        hitSlop={6}
        style={({ pressed }) => [styles.gear, pressed && { backgroundColor: color.pressed }]}
      >
        <Icon name="settings" size={20} color={color.ink} />
      </Pressable>
    </View>
  );

  const tileW = (contentWidth - TILE_GAP) / 2;
  const sorted = [...holdings].sort((a, b) => b.value - a.value);
  const held = new Set(holdings.map((h) => h.symbol));
  const holdColors = stackColors([...sorted.map((h) => stockColor(h.symbol)), cashColor]);
  const toSend = stocks.filter((s) => !held.has(s.symbol));
  const sendColors = gridColors(toSend.map((s) => stockColor(s.symbol)));

  const accountTab = (
    <>
      <View style={styles.hero}>
        {portfolio ? (
          <>
            <Text style={styles.label}>{copy.balance}</Text>
            <BigNumber value={portfolio.total} size="balance" align="left" style={{ marginTop: 8 }} />
            {holdings.length > 0 && line.changePct != null ? (
              <View style={styles.todayRow}>
                <Change value={line.changePct} />
                <Text style={styles.caption}>{copy.today}</Text>
              </View>
            ) : portfolio.total <= 0 ? (
              <Text style={[styles.caption, styles.todayRow]}>{copy.emptyAccount}</Text>
            ) : null}
          </>
        ) : failed ? (
          <>
            <Text style={styles.label}>{copy.balance}</Text>
            <Text style={styles.failed}>{copy.couldntLoad}</Text>
            <PillButton onPress={() => void load()} style={{ alignSelf: 'flex-start', marginTop: 14 }}>
              {copy.retry}
            </PillButton>
          </>
        ) : (
          <>
            <View style={[styles.skel, { width: 72, height: 18 }]} />
            <View style={[styles.skel, { width: 230, height: 66, borderRadius: 20, marginTop: 8 }]} />
            <View style={[styles.skel, { width: 96, height: 24, marginTop: 10 }]} />
          </>
        )}
      </View>

      {(holdings.length > 0 || cash > 0) && (
        <View style={styles.section}>
          <SectionLabel>{copy.yourStocks}</SectionLabel>
          <View style={styles.stack}>
            {sorted.map((h, i) => (
              <WalletCard
                key={h.symbol}
                first={i === 0}
                colors={holdColors[i]}
                name={h.name}
                tickerText={ticker(h.symbol)}
                value={usd2(h.value)}
                change={market.get(h.symbol)?.changePct}
                onPress={() => props.onOpenStock({ symbol: h.symbol, name: h.name })}
              />
            ))}
            <WalletCard
              first={sorted.length === 0}
              colors={holdColors[sorted.length]}
              name={copy.cashTile}
              tickerText={copy.cashTicker}
              value={usd2(cash)}
              footer={cash > 0 ? copy.readyToSend : copy.addCashFirst}
              onPress={cash > 0 ? props.onSend : props.onBuy}
            />
          </View>
        </View>
      )}

      {toSend.length > 0 && (
        <View style={styles.section}>
          <SectionLabel>{copy.stocksYouCanSend}</SectionLabel>
          <View style={[styles.grid, { marginTop: 12 }]}>
            {toSend.map((s, i) => {
              const m = market.get(s.symbol);
              return (
                <StockTile
                  key={s.symbol}
                  width={tileW}
                  colors={sendColors[i]}
                  name={s.name}
                  tickerText={ticker(s.symbol)}
                  value={m?.priceUsd ? usd2(m.priceUsd) : ''}
                  change={m?.changePct}
                  spark={m?.spark}
                  onPress={() => props.onOpenStock(s)}
                />
              );
            })}
          </View>
        </View>
      )}

    </>
  );

  const onWren = people?.onWren ?? [];
  const personW = (width - 32 - TILE_GAP) / 2;
  // Each person's newest move (moves come newest first).
  const latestMove = new Map<string, Move>();
  for (const m of moves?.items ?? []) if (!latestMove.has(m.phone)) latestMove.set(m.phone, m);
  const notOnWren = people?.notOnWren ?? [];
  const query = friendQ.trim().toLowerCase();
  const match = (p: WrenPerson) => !query || p.name.toLowerCase().includes(query);
  const friends = onWren.filter(match);
  const invitees = notOnWren.filter(match);
  const friendColors = stackColors(friends.map((p) => personColor(p.name)));
  const inviteColors = stackColors(invitees.map(() => quietColor));

  // Friends: one job, send someone a stock. Friends on Wren first, in their
  // color, with their latest buy; everyone else after as quiet cards, where
  // the first send is the invite. Moves live on the cards and in profiles.
  const peopleTab = (
    <>
      <View style={styles.hero}>
        <Text style={styles.headline}>{copy.yourPeople}</Text>
        <Text style={styles.sub}>{copy.friendsSub}</Text>
        <SearchField value={friendQ} onChange={setFriendQ} placeholder={copy.searchFriends} style={{ marginTop: 18 }} />
      </View>

      {friends.length > 0 && (
        <View style={[styles.stackWrap, { marginTop: 18 }]}>
          {friends.map((p, i) => {
            const last = latestMove.get(p.phone);
            return (
              <PersonCard
                key={p.phone}
                first={i === 0}
                colors={friendColors[i]}
                name={p.name.split(' ')[0]}
                line={last ? `${copy.boughtShort(last.stockName)} · ${when(last.at)}` : undefined}
                onPress={() => props.onOpenPerson(p.phone, p.name)}
                onSend={() => props.onSendTo(p)}
              />
            );
          })}
        </View>
      )}

      {invitees.length > 0 && (
        <View style={styles.section}>
          <SectionLabel>{copy.inviteLabel}</SectionLabel>
          <Text style={[styles.caption, { marginTop: 4 }]}>{copy.notOnWrenNote}</Text>
          <View style={{ marginTop: 12, marginHorizontal: 16 - spacing.screenPad }}>
            {invitees.map((p, i) => (
              <PersonCard
                key={p.phone}
                first={i === 0}
                colors={inviteColors[i]}
                quiet
                name={p.name}
                onPress={() => props.onSendTo(p)}
                onSend={() => props.onSendTo(p)}
              />
            ))}
          </View>
        </View>
      )}

      {people && !friends.length && !invitees.length && (
        <View style={styles.padded}>
          <EmptyCard>{query ? copy.noFriendMatch(friendQ.trim()) : copy.noPeople}</EmptyCard>
        </View>
      )}
    </>
  );

  const activityTab = (
    <View style={styles.hero}>
      <Text style={styles.headline}>{copy.activity}</Text>
      <Text style={styles.sub}>{copy.onlyYou}</Text>
      <View style={{ marginTop: 16 }}>
        {activity?.length ? (
          <ActivityRows
            items={activity}
            onOpen={(a) =>
              a.kind === 'buy'
                ? props.onOpenStock({ symbol: a.symbol, name: a.stockName })
                : a.phone && props.onOpenPerson(a.phone, a.name ?? undefined)
            }
          />
        ) : activity ? (
          <EmptyCard>{copy.noSends}</EmptyCard>
        ) : null}
      </View>
    </View>
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {top}
      <ScrollView
        contentContainerStyle={{ paddingBottom: 200 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        showsVerticalScrollIndicator={false}
      >
        {tab === 'account' ? accountTab : tab === 'people' ? peopleTab : activityTab}
      </ScrollView>
      <View style={[styles.pinned, { paddingBottom: Math.max(insets.bottom, spacing.homeIndicator) }]}>
        {channel !== undefined && (
          <Pressable onPress={props.onConnect} hitSlop={8}>
            <Text style={styles.channel}>{channel ? copy.channelLine(channel) : copy.channelNone}</Text>
          </Pressable>
        )}
        <View style={styles.actions}>
          <Button variant="secondary" onPress={props.onBuy} style={{ flex: 1 }}>
            {copy.buy}
          </Button>
          <Button onPress={props.onSend} style={{ flex: 2 }}>
            {copy.send}
          </Button>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.canvas },
  top: {
    height: layout.topBar + 12,
    paddingHorizontal: spacing.screenPad,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  logo: { width: 34, height: 34, resizeMode: 'contain' },
  gear: { width: 40, height: 40, borderRadius: 20, backgroundColor: color.card, alignItems: 'center', justifyContent: 'center' },
  hero: { paddingHorizontal: spacing.screenPad, paddingTop: 20 },
  padded: { paddingHorizontal: spacing.screenPad, marginTop: 20 },
  label: { ...type.label, color: color.textSecondary },
  title: { ...type.title, color: color.ink },
  headline: { ...type.headline, color: color.ink },
  sub: { ...type.bodyRegular, color: color.textSecondary, marginTop: 10 },
  moveRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  moveMeta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6, marginLeft: 4 },
  caption: { ...type.caption, color: color.textSecondary },
  failed: { ...type.titleSm, color: color.ink, marginTop: 14 },
  todayRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: TILE_GAP },
  stack: { marginTop: 12 },
  stackWrap: { paddingHorizontal: 16 },
  personTile: { height: 150, borderRadius: 28, padding: 16, justifyContent: 'space-between' },
  personFace: { width: 44, height: 44, borderRadius: 22, backgroundColor: color.canvas, alignItems: 'center', justifyContent: 'center' },
  personInitial: { fontFamily: font.display, fontSize: 20, color: color.ink },
  personName: { fontFamily: font.display, fontSize: 24, lineHeight: 28, letterSpacing: -0.6 },
  personLine: { fontFamily: font.uiRegular, fontSize: 13, lineHeight: 18, marginTop: 4, opacity: 0.85 },
  skel: { backgroundColor: color.card, borderRadius: 999 },
  section: { paddingHorizontal: spacing.screenPad, marginTop: 24 },
  stockRow: { minHeight: 72, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 12 },
  mid: { flex: 1, minWidth: 0 },
  body: { ...type.body, color: color.ink },
  ticker: { ...type.ticker, color: color.textSecondary, marginTop: 2 },
  price: { ...type.price, color: color.ink },
  valueCol: { width: 92, alignItems: 'flex-end', gap: 4 },
  seeAll: { ...type.label, color: color.ink },
  whenText: { ...type.caption, color: color.textTertiary },
  faces: { paddingHorizontal: spacing.screenPad, gap: 14, marginTop: 24 },
  face: { width: 84, alignItems: 'center', gap: 8 },
  faceName: { ...type.label, color: color.ink },
  inviteRow: { minHeight: 72, flexDirection: 'row', alignItems: 'center', gap: 12 },
  pinned: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: 16,
    paddingHorizontal: spacing.screenPad,
    backgroundColor: color.canvas,
    gap: 12,
  },
  channel: { ...type.caption, color: color.textSecondary, textAlign: 'center' },
  actions: { flexDirection: 'row', gap: 10 },
});
