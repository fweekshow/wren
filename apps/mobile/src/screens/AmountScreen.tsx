// Amount: stock pills (scrolling), big entry, presets, keypad.
// Apple Pay only — no card pill. On Continue we post once and hand off to
// Safari via Linking.openURL. If the request fails, we restore Continue and
// say "That didn't go through."

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, spacing, type } from '../theme';
import { Wren } from '../components/Wren';
import { BigNumber } from '../components/BigNumber';
import { StockPicker } from '../components/StockPicker';
import { Presets } from '../components/Presets';
import { applyKey, Keypad } from '../components/Keypad';
import { Button } from '../components/Button';
import { Avatar } from '../components/Avatar';
import { HeaderBack } from '../components/HeaderBack';
import { getGiftStatus, getStocks, sendGift, startPay, Stock, type PayMethod } from '../api';
import { copy } from '../copy';
import { track } from '../observe';
import type { Person } from '../contacts';

type Props = {
  person: Person;
  phone: string; // E.164
  onBack: () => void;
  onSent: (result: { giftId: string; usd: number; symbol: string }) => void;
};

type Phase = 'edit' | 'posting' | 'waiting' | 'error';

export function AmountScreen({ person, phone, onBack, onSent }: Props) {
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [symbol, setSymbol] = useState<string | undefined>(undefined);
  const [amount, setAmount] = useState<string>('');
  const [phase, setPhase] = useState<Phase>('edit');
  const [error, setError] = useState<string | null>(null);
  const [chargeUsd, setChargeUsd] = useState<number | null>(null);
  const [payMethod, setPayMethod] = useState<PayMethod>('apple');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await getStocks();
        if (cancelled) return;
        setStocks(list);
        if (!symbol && list.length) setSymbol(list[0].symbol);
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
    track('buy_started', { method: payMethod, symbol });
    try {
      await startPay(payMethod, numeric);
      const gift = await sendGift({
        symbol,
        usd: numeric,
        recipient: { name: person.firstName, phone },
      });
      track('buy_succeeded', { giftId: gift.giftId });
      setChargeUsd(gift.chargeUsd);
      setPhase('waiting');
      startPolling(gift.giftId, numeric, symbol);
    } catch {
      track('buy_failed', { symbol });
      setError(copy.didntGo);
      setPhase('error');
    }
  }, [symbol, numeric, person.firstName, phone, startPolling, payMethod]);

  // Restore Continue after an error on next edit.
  const edit = (next: string | ((s: string) => string)) => {
    if (phase === 'error') {
      setPhase('edit');
      setError(null);
    }
    setAmount((s) => (typeof next === 'function' ? next(s) : next));
  };

  const primaryLabel = phase === 'waiting' ? copy.stillWorking : phase === 'posting' ? '…' : copy.pay;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <HeaderBack
        onBack={onBack}
        right={
          <View style={styles.who}>
            <Avatar name={person.firstName} size={28} />
            <Text style={styles.whoText}>{person.firstName}</Text>
          </View>
        }
      />
      <View style={styles.hero}>
        <Wren size={96} style={{ marginBottom: 6 }} />
        <View style={{ height: 92, justifyContent: 'center' }}>
          <BigNumber value={numeric} size="amount" cents={amount.includes('.')} />
        </View>
      </View>
      <StockPicker
        stocks={stocks}
        value={symbol}
        onChange={setSymbol}
        style={{ marginTop: 6 }}
      />
      <Presets value={amount} onChange={(v) => edit(String(v))} style={{ marginTop: 16 }} />
      <View style={styles.keypadWrap}>
        <Keypad keyHeight={50} onKey={(k) => edit((a) => applyKey(a, k))} />
      </View>
      <View style={styles.footer}>
        {error ? (
          <Text style={styles.error}>{error}</Text>
        ) : (
          <View style={styles.methods}>
            {(['apple', 'card', 'bank'] as PayMethod[]).map((method) => (
              <Pressable
                key={method}
                onPress={() => setPayMethod(method)}
                style={[styles.method, payMethod === method && styles.methodOn]}
              >
                <Text style={[styles.methodText, payMethod === method && styles.methodTextOn]}>
                  {method === 'apple' ? copy.applePay : method === 'card' ? copy.card : copy.bank}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
        {chargeUsd != null && phase === 'waiting' && (
          <Text style={styles.total}>
            Total ${chargeUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · includes $2.99 Wren
          </Text>
        )}
        <Button
          disabled={phase === 'posting' || phase === 'waiting' || (phase === 'edit' && !(numeric > 0 && !!symbol))}
          loading={phase === 'posting'}
          onPress={phase === 'error' ? () => setPhase('edit') : phase === 'waiting' ? () => {} : onContinue}
        >
        {phase === 'error' ? copy.retry : primaryLabel}
        </Button>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.canvas },
  who: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingRight: 12,
  },
  whoText: { ...type.body, color: color.textPrimary },
  hero: {
    alignItems: 'center',
    paddingTop: 8,
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
  methods: { flexDirection: 'row', justifyContent: 'center', gap: 8 },
  method: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: color.card,
  },
  methodOn: { backgroundColor: color.ink },
  methodText: { ...type.caption, color: color.textPrimary },
  methodTextOn: { color: color.textOnAction },
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
