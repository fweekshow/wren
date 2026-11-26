// Amount: the amount as your blue bubble ("To Maya" under it, like a sent
// text), then stock pills (scrolling), presets, keypad.
// Sends always pay from cash (in your Wren account, no card cost). Not enough
// cash → "You have $20 in cash. Add $30 to send this." and the button becomes
// Pay $31: the Pay card adds the cash (Apple Pay or card), then it sends.
// If the request fails, we restore Pay and say "That didn't go through."

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Keyboard,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, layout, spacing, type } from '../theme';
import { BubbleCard } from '../components/BubbleCard';
import { BigNumber } from '../components/BigNumber';
import { ChosenStock } from '../components/Market';
import { Presets } from '../components/Presets';
import { applyKey, Keypad } from '../components/Keypad';
import { Button } from '../components/Button';
import { HeaderBack } from '../components/HeaderBack';
import { PayCard, topUpFor } from '../components/PayCard';
import {
  getGiftStatus,
  getPortfolio,
  getSendQuote,
  getStocks,
  notEnoughCash,
  sendGift,
  Stock,
  type SendQuote,
} from '../api';
import { copy } from '../copy';
import { track } from '../observe';
import { usd2 } from '../fees';
import type { Person } from '../contacts';

type Props = {
  person: Person;
  phone: string; // E.164
  initialSymbol?: string;
  onBack: () => void;
  onSent: (result: { giftId: string; usd: number; symbol: string }) => void;
  onChangeStock: () => void;
};

type Phase = 'edit' | 'posting' | 'waiting' | 'error';

export function AmountScreen({ person, phone, initialSymbol, onBack, onSent, onChangeStock }: Props) {
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [symbol, setSymbol] = useState<string | undefined>(initialSymbol);
  // Change → the stock picker → back here with the new pick.
  useEffect(() => {
    if (initialSymbol) setSymbol(initialSymbol);
  }, [initialSymbol]);
  const [cash, setCash] = useState<number | null>(null);
  const [short, setShort] = useState<{ cashUsd: number; neededUsd: number } | null>(null);
  const [amount, setAmount] = useState<string>('');
  const [phase, setPhase] = useState<Phase>('edit');
  const [error, setError] = useState<string | null>(null);
  const [chargeUsd, setChargeUsd] = useState<number | null>(null);
  const [paying, setPaying] = useState(false);
  const { width } = useWindowDimensions();
  const bubbleWidth = width - spacing.screenPad * 2;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await getStocks();
        if (cancelled) return;
        setStocks(list);
        if (!symbol && list.length) setSymbol(list[0].symbol);
        const p = await getPortfolio(list).catch(() => null);
        if (cancelled || !p) return;
        setCash(p.cash);
      } catch {
        // Leave the picker empty; Continue stays disabled until we have a symbol.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const numeric = useMemo(() => Number(amount) || 0, [amount]);

  // The price before Pay comes from the server, so first-send-free and the
  // card cost are exactly what will be charged.
  const [quote, setQuote] = useState<SendQuote | null>(null);
  useEffect(() => {
    if (!(numeric > 0)) {
      setQuote(null);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      getSendQuote(numeric, 'cash')
        .then((q) => {
          if (alive) setQuote(q);
        })
        .catch(() => {
          if (alive) setQuote(null);
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [numeric]);
  const canContinue = numeric > 0 && !!symbol && phase === 'edit';

  // Poll /api/muse/sends/:id after the user heads to Safari. When status flips
  // to "sent", advance to the Sent screen. We stop on unmount or on advance.
  const pollAlive = useRef(true);
  useEffect(() => {
    pollAlive.current = true;
    return () => {
      pollAlive.current = false;
    };
  }, []);

  const startPolling = useCallback(
    (giftId: string, usd: number, sym: string) => {
      const started = Date.now();
      let delay = 1200;
      const tick = async () => {
        if (!pollAlive.current) return;
        if (Date.now() - started > 60_000) {
          setError(copy.stillWorking);
          setPhase('error');
          pollAlive.current = false;
          return;
        }
        try {
          const r = await getGiftStatus(giftId);
          if (!pollAlive.current) return;
          if (r.status === 'sent') {
            pollAlive.current = false;
            track('send_success', { giftId });
            onSent({ giftId, usd, symbol: sym });
            return;
          }
          if (r.status === 'failed') {
            track('buy_failed', { giftId });
            setError(copy.didntGo);
            setPhase('error');
            pollAlive.current = false;
            return;
          }
        } catch {
          // Keep polling.
        }
        delay = Math.min(delay + 400, 4000);
        setTimeout(tick, delay);
      };
      setTimeout(tick, delay);
    },
    [onSent],
  );

  const onContinue = useCallback(async () => {
    if (!symbol) return;
    Keyboard.dismiss();
    setPhase('posting');
    setError(null);
    track('buy_started', { method: 'cash', symbol });
    try {
      const gift = await sendGift({
        symbol,
        usd: numeric,
        recipient: { name: person.firstName, phone },
        payFrom: 'cash',
      });
      track('buy_succeeded', { giftId: gift.giftId });
      setChargeUsd(gift.chargeUsd);
      setPhase('waiting');
      startPolling(gift.giftId, numeric, symbol);
    } catch (err) {
      const s = notEnoughCash(err);
      if (s) {
        setShort(s);
        setPhase('edit');
        return;
      }
      track('buy_failed', { symbol });
      setError(copy.didntGo);
      setPhase('error');
    }
  }, [symbol, numeric, person.firstName, phone, startPolling]);

  // Restore Continue after an error on next edit.
  const edit = (next: string | ((s: string) => string)) => {
    setShort(null);
    if (phase === 'error') {
      setPhase('edit');
      setError(null);
    }
    setAmount((s) => (typeof next === 'function' ? next(s) : next));
  };

  // Short on cash: what the server said (402), or what the quote says now.
  const knownShortBy = cash != null && quote && numeric > 0 ? quote.totalUsd - cash : 0;
  const shortBy = short ? short.neededUsd - short.cashUsd : knownShortBy > 0.005 ? knownShortBy : 0;

  const primaryLabel = phase === 'waiting' ? copy.stillWorking : phase === 'posting' ? '…' : copy.pay;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <HeaderBack onBack={onBack} />
      <View style={styles.hero}>
        <BubbleCard from="you" style={[styles.bubble, { maxWidth: bubbleWidth }]}>
          <BigNumber
            value={numeric}
            size="amountXl"
            tone="onBlue"
            cents={amount.includes('.')}
            fitWidth={bubbleWidth - 48}
          />
        </BubbleCard>
        <Text style={styles.to}>
          {copy.amountTo} {person.firstName}
        </Text>
      </View>
      {symbol ? (
        <ChosenStock
          name={stocks.find((s) => s.symbol === symbol)?.name ?? symbol.replace(/c$/, '')}
          symbol={symbol}
          onChange={onChangeStock}
          style={{ marginTop: 10, marginHorizontal: 16 }}
        />
      ) : null}
      <Presets value={amount} onChange={(v) => edit(String(v))} style={{ marginTop: 16 }} />
      <View style={styles.keypadWrap}>
        <Keypad keyHeight={50} onKey={(k) => edit((a) => applyKey(a, k))} />
      </View>
      <View style={styles.footer}>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {shortBy > 0 ? (
          <Text style={styles.total}>
            {copy.notEnoughCashSend(usd2(short?.cashUsd ?? cash ?? 0), usd2(Math.max(shortBy, 0.01)))}
          </Text>
        ) : numeric > 0 && quote && quote.stockUsd === Math.round(numeric * 100) / 100 && (
          // The price before Pay, never a surprise after.
          <Text style={styles.total}>
            {[
              `${copy.total} ${usd2(chargeUsd ?? quote.totalUsd)}`,
              quote.firstSend ? copy.firstSendFree : copy.toSend(usd2(quote.feeUsd)),
              quote.cardUsd > 0 ? copy.cardCost(usd2(quote.cardUsd)) : null,
              copy.fromYourCash,
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        )}
        {shortBy > 0 && phase === 'edit' ? (
          <Button onPress={() => setPaying(true)}>{`${copy.pay} ${usd2(topUpFor(shortBy))}`}</Button>
        ) : (
        <Button
          disabled={phase === 'posting' || phase === 'waiting' || (phase === 'edit' && !(numeric > 0 && !!symbol))}
          loading={phase === 'posting'}
          onPress={phase === 'error' ? () => setPhase('edit') : phase === 'waiting' ? () => {} : onContinue}
        >
        {phase === 'error' ? copy.retry : primaryLabel}
        </Button>
        )}
      </View>
      <PayCard
        visible={paying}
        amount={topUpFor(Math.max(shortBy, 0.01))}
        onClose={() => setPaying(false)}
        onPaid={(c) => {
          setPaying(false);
          setCash(c);
          setShort(null);
          void onContinue();
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.canvas },
  hero: {
    paddingHorizontal: spacing.screenPad,
    paddingTop: layout.titleGap,
  },
  bubble: {
    minWidth: 160,
    height: 132,
    paddingHorizontal: 24,
    // Line height carries descender space; nudge the digits to look centered.
    paddingTop: 12,
    justifyContent: 'center',
  },
  to: {
    ...type.caption,
    color: color.textSecondary,
    alignSelf: 'flex-end',
    marginTop: 8,
  },
  keypadWrap: {
    paddingHorizontal: 32,
    paddingTop: 12,
  },
  footer: {
    position: 'absolute',
    left: spacing.screenPad,
    right: spacing.screenPad,
    bottom: spacing.homeIndicator,
    gap: 10,
  },
  total: {
    ...type.caption,
    color: color.textSecondary,
    textAlign: 'center',
  },
  error: {
    ...type.caption,
    color: color.moveDown,
    textAlign: 'center',
  },
});
