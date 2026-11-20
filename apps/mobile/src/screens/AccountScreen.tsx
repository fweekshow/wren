// Account, the home screen. Top bar: logo · Account | People · Settings.
//
// Account tab (Wren Bold, B7): a big balance with today's change, stocks as
// tiles (your biggest in Wren Blue) plus Cash, and the latest send as a bubble.
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
import { color, layout, spacing, type } from '../theme';
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
import { Card, Change, PillButton, rowLine, SectionLabel, Segmented, StockTile } from '../components/Market';
import { BubbleCard } from '../components/BubbleCard';
import { EmptyCard, stateLabel } from './ActivityScreen';

type Tab = 'account' | 'people';

type Props = {
  tab: Tab;
  onTab: (t: Tab) => void;
  onSend: () => void;
  onBuy: () => void;
  onOpenStock: (stock: Stock) => void;
  onSettings: () => void;
  onActivity: () => void;
  onConnect: () => void;
  onOpenPerson: (phone: string) => void;
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
        ]}
      />
      <PillButton onPress={props.onSettings}>{copy.settings}</PillButton>
    </View>
  );

  const tileW = (contentWidth - TILE_GAP) / 2;
  const sorted = [...holdings].sort((a, b) => b.value - a.value);
  const latest = activity?.[0];

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

      <View style={styles.section}>
        {!holdings.length && <SectionLabel>{copy.stocksYouCanSend}</SectionLabel>}
        <View style={[styles.grid, !holdings.length && { marginTop: 12 }]}>
          {holdings.length
            ? sorted.map((h, i) => (
                <StockTile
                  key={h.symbol}
                  width={tileW}
                  blue={i === 0}
                  name={h.name}
                  tickerText={ticker(h.symbol)}
                  value={usd2(h.value)}
                  change={market.get(h.symbol)?.changePct}
                  onPress={() => props.onOpenStock({ symbol: h.symbol, name: h.name })}
                />
              ))
            : stocks.map((s) => {
                const m = market.get(s.symbol);
                return (
                  <StockTile
                    key={s.symbol}
                    width={tileW}
                    name={s.name}
                    tickerText={ticker(s.symbol)}
                    value={m?.priceUsd ? usd2(m.priceUsd) : ''}
                    change={m?.changePct}
                    onPress={() => props.onOpenStock(s)}
                  />
                );
              })}
          {portfolio && (holdings.length > 0 || cash > 0) && (
            <StockTile
              width={tileW}
              name={copy.cashTile}
              tickerText={copy.cashTicker}
              value={usd2(cash)}
              footer={cash > 0 ? copy.readyToSend : copy.addCashFirst}
              onPress={cash > 0 ? props.onSend : props.onBuy}
            />
          )}
        </View>
      </View>

      <View style={styles.section}>
        <SectionLabel
          right={
            activity?.length ? (
              <Pressable onPress={props.onActivity} hitSlop={10}>
                <Text style={styles.seeAll}>{copy.seeAll}</Text>
              </Pressable>
            ) : null
          }
        >
          {copy.latest}
        </SectionLabel>
        <View style={{ marginTop: 10 }}>
          {latest ? (
            <Pressable
              onPress={() => latest.phone && props.onOpenPerson(latest.phone)}
              style={{ alignSelf: 'flex-end', alignItems: 'flex-end' }}
            >
              <BubbleCard from="you">
                {copy.youSentWho(
                  (latest.name ?? latest.phone ?? copy.someone).split(' ')[0],
                  copy.sendWhat(usdShort(latest.usd), latest.stockName),
                )}
              </BubbleCard>
              <Text style={[styles.whenText, { marginTop: 6 }]}>
                {stateLabel(latest)} · {when(latest.at)}
              </Text>
            </Pressable>
          ) : (
            <EmptyCard>{copy.noSends}</EmptyCard>
          )}
        </View>
      </View>
    </>
  );

  const onWren = people?.onWren ?? [];
  const notOnWren = people?.notOnWren ?? [];
  const peopleTab = (
    <>
      <View style={styles.hero}>
        <Text style={styles.title}>{copy.yourPeople}</Text>
        <Text style={[styles.caption, { marginTop: 6 }]}>{copy.peopleCount(onWren.length)}</Text>
      </View>

      {onWren.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.faces}>
          {onWren.map((p) => (
            <Pressable key={p.phone} onPress={() => props.onOpenPerson(p.phone)} style={styles.face}>
              <Avatar name={p.name} size={56} />
              <Text style={styles.faceName} numberOfLines={1}>
                {p.name.split(' ')[0]}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : (
        <View style={styles.padded}>
          <EmptyCard>{copy.noPeople}</EmptyCard>
        </View>
      )}

      {onWren.length > 0 && (
        <View style={styles.section}>
          <SectionLabel>{copy.moves}</SectionLabel>
          <View style={{ marginTop: 12 }}>
            {moves && !moves.sharing ? (
              <EmptyCard
                action={
                  <PillButton dark onPress={props.onSettings} style={{ alignSelf: 'flex-start' }}>
                    {copy.shareToSeeButton}
                  </PillButton>
                }
              >
                {copy.shareToSee}
              </EmptyCard>
            ) : moves?.items.length ? (
              <Card>
                {moves.items.map((m, i) => (
                  <Pressable
                    key={`${m.phone}-${m.at}`}
                    onPress={() => props.onOpenPerson(m.phone)}
                    style={[styles.moveRow, rowLine(i, moves.items.length)]}
                  >
                    <Avatar name={m.name || '?'} size={40} />
                    <View style={styles.mid}>
                      <Text style={styles.body} numberOfLines={1}>
                        {copy.moveBought(m.name.split(' ')[0] || copy.someone, m.stockName)}
                      </Text>
                      <Text style={styles.whenText}>{when(m.at)}</Text>
                    </View>
                    <Change value={market.get(m.symbol)?.changePct} />
                  </Pressable>
                ))}
              </Card>
            ) : (
              <EmptyCard>{copy.noMoves}</EmptyCard>
            )}
          </View>
        </View>
      )}

      {notOnWren.length > 0 && (
        <View style={styles.section}>
          <SectionLabel>{copy.notOnWren}</SectionLabel>
          <Text style={[styles.caption, { marginTop: 4 }]}>{copy.notOnWrenNote}</Text>
          <View style={{ marginTop: 8 }}>
            {notOnWren.map((p) => (
              <View key={p.phone} style={styles.inviteRow}>
                <Avatar name={p.name} size={40} />
                <Text style={[styles.body, { flex: 1 }]} numberOfLines={1}>
                  {p.name}
                </Text>
                <PillButton onPress={() => props.onSendTo(p)}>{copy.send}</PillButton>
              </View>
            ))}
          </View>
        </View>
      )}
    </>
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {top}
      <ScrollView
        contentContainerStyle={{ paddingBottom: 200 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        showsVerticalScrollIndicator={false}
      >
        {tab === 'account' ? accountTab : peopleTab}
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
  hero: { paddingHorizontal: spacing.screenPad, paddingTop: 20 },
  padded: { paddingHorizontal: spacing.screenPad, marginTop: 20 },
  label: { ...type.label, color: color.textSecondary },
  title: { ...type.title, color: color.ink },
  caption: { ...type.caption, color: color.textSecondary },
  failed: { ...type.titleSm, color: color.ink, marginTop: 14 },
  todayRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: TILE_GAP },
  skel: { backgroundColor: color.card, borderRadius: 999 },
  section: { paddingHorizontal: spacing.screenPad, marginTop: 24 },
  stockRow: { minHeight: 72, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 12 },
  moveRow: { minHeight: 68, paddingVertical: 12, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 10 },
  mid: { flex: 1, minWidth: 0 },
  body: { ...type.body, color: color.ink },
  ticker: { ...type.ticker, color: color.textSecondary, marginTop: 2 },
  price: { ...type.price, color: color.ink },
  valueCol: { width: 92, alignItems: 'flex-end', gap: 4 },
  seeAll: { ...type.label, color: color.ink },
  whenText: { ...type.caption, color: color.textTertiary },
  faces: { paddingHorizontal: spacing.screenPad, gap: 12, marginTop: 20 },
  face: { width: 64, alignItems: 'center', gap: 6 },
  faceName: { ...type.label, color: color.ink },
  inviteRow: {
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairline,
  },
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
