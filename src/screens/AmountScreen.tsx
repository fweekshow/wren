// Amount: stock pills (scrolling), big entry, presets, keypad.
// Apple Pay only — no card pill. On Continue we post once and hand off to
// Safari via Linking.openURL. If the request fails, we restore Continue and
// say "That didn't go through."

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Keyboard,
  Linking,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, font, spacing, type } from '../theme';
import { Wren } from '../components/Wren';
import { BigNumber } from '../components/BigNumber';
import { StockPicker } from '../components/StockPicker';
import { Presets } from '../components/Presets';
import { applyKey, Keypad } from '../components/Keypad';
import { Button } from '../components/Button';
import { Avatar } from '../components/Avatar';
import { HeaderBack } from '../components/HeaderBack';
import { createGift, getGiftStatus, getStocks, Stock } from '../api';
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
      let delay = 1200;
      const tick = async () => {
        if (!pollAlive.current) return;
        try {
          const r = await getGiftStatus(giftId);
          if (!pollAlive.current) return;
          if (r.status === 'sent') {
            pollAlive.current = false;
            onSent({ giftId, usd, symbol: sym });
            return;
          }
          if (r.status === 'failed') {
            setError("That didn't go through.");
            setPhase('error');
            pollAlive.current = false;
            return;
          }
        } catch {
          // Transient (e.g. user is still in Safari). Keep polling with backoff.
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
    try {
      const gift = await createGift({
        symbol, // posted exactly as returned by /api/app/stocks
        usd: numeric,
        recipient: { name: person.firstName, phone },
      });
      setChargeUsd(gift.chargeUsd);
      setPhase('waiting');
      // Hand off to Safari. We do not try to fix the pay page.
      await Linking.openURL(gift.payUrl);
      startPolling(gift.giftId, numeric, symbol);
    } catch {
      setError("That didn't go through.");
      setPhase('error');
    }
  }, [symbol, numeric, person.firstName, phone, startPolling]);

  // Restore Continue after an error on next edit.
  const edit = (next: string | ((s: string) => string)) => {
    if (phase === 'error') {
      setPhase('edit');
      setError(null);
    }
    setAmount((s) => (typeof next === 'function' ? next(s) : next));
  };

  const primaryLabel =
    phase === 'waiting'
      ? 'Finish in Safari'
      : phase === 'posting'
        ? '…'
        : 'Continue';

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
          <Text style={styles.pay}>Apple Pay</Text>
        )}
        {chargeUsd != null && phase === 'waiting' && (
          <Text style={styles.total}>
            Total ${chargeUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · includes $2.99 Wren
          </Text>
        )}
        <Button
          disabled={!canContinue && phase !== 'waiting'}
          loading={phase === 'posting'}
          onPress={phase === 'waiting' ? () => {} : onContinue}
        >
          {primaryLabel}
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
  pay: {
    fontFamily: font.ui,
    fontSize: 14,
    lineHeight: 16,
    color: color.textSecondary,
    textAlign: 'center',
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
