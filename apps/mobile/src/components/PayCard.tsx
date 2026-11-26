// The Pay card: one bottom sheet with both ways to add cash.
// - Apple Pay, through Coinbase: the server makes a Coinbase order and we load
//   its payment page in a hidden WebView. When the page is ready we press its
//   Apple Pay button (as Coinbase's own React Native demo does), so the native
//   Apple Pay sheet comes up. USDC lands in the person's wallet (their cash).
//   Coinbase needs a verified email once: we ask for it and a 6-digit code.
// - Card, through Privy's funding sheet (as before).
// Either way we then watch the cash balance until the money shows up.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent, type WebViewProps } from 'react-native-webview';
import { useEmbeddedEthereumWallet } from '@privy-io/expo';
import { useFundWallet } from '@privy-io/expo/ui';
import { base } from 'viem/chains';
import { color, radius, spacing, type } from '../theme';
import { Button } from './Button';
import {
  apiErrorCode,
  getApplePayQuote,
  getCash,
  type ApplePayQuote,
  sendApplePayEmail,
  startApplePay,
  verifyApplePayEmail,
} from '../api';
import { copy } from '../copy';
import { usd2 } from '../fees';
import { track } from '../observe';

// react-native-webview's class typings resolve to `never` props with this
// React Native/React version; the component itself is fine.
const CoinbaseWebView = WebView as unknown as React.ComponentType<
  WebViewProps & { ref?: React.Ref<WebView> }
>;

// Coinbase's page talks to iOS apps through window.webkit.messageHandlers.cbOnramp
// (their iOS docs: the name must be exactly "cbOnramp"). react-native-webview
// only registers "ReactNativeWebView", so add a cbOnramp that forwards to it,
// and forward window postMessage events too. Runs before the page's scripts.
const CB_ONRAMP_BRIDGE = `
(function () {
  function send(m) {
    try {
      window.ReactNativeWebView.postMessage(typeof m === 'string' ? m : JSON.stringify(m));
    } catch (e) {}
  }
  try {
    var h = window.webkit && window.webkit.messageHandlers;
    if (h && !h.cbOnramp) {
      try { Object.defineProperty(h, 'cbOnramp', { value: { postMessage: send }, configurable: true }); }
      catch (e) { h.cbOnramp = { postMessage: send }; }
    }
  } catch (e) {}
  window.addEventListener('message', function (e) {
    var d = e && e.data;
    if (d && (typeof d === 'string' ? d.indexOf('onramp_api.') >= 0 : String(d.eventName || '').indexOf('onramp_api.') === 0)) send(d);
  });
})();
true;
`;

/** Coinbase's Apple Pay minimum. */
export const APPLE_PAY_MIN_USD = 5;

/** Cash to add to cover `shortUsd`: exactly that (fees are on top), $5 minimum. */
export function topUpFor(shortUsd: number): number {
  return Math.max(APPLE_PAY_MIN_USD, Math.ceil(shortUsd * 100 - 1e-6) / 100);
}

type Step = 'choose' | 'email' | 'code' | 'opening' | 'waiting' | 'slow';

type Props = {
  visible: boolean;
  amount: number;
  onClose: () => void;
  /** Cash arrived; `cash` is the new balance. */
  onPaid: (cash: number) => void;
};

const WAIT_MS = 120_000;
const POLL_MS = 3000;

export function PayCard({ visible, amount, onClose, onPaid }: Props) {
  const insets = useSafeAreaInsets();
  const wallets = useEmbeddedEthereumWallet();
  const { fundWallet } = useFundWallet();
  const [step, setStep] = useState<Step>('choose');
  // Apple Pay total with Coinbase's fee on top, shown before the tap.
  const [quote, setQuote] = useState<ApplePayQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [appleOff, setAppleOff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [payUrl, setPayUrl] = useState<string | null>(null);
  // Privy's card sheet draws at the app root, under this Modal: step aside while it's open.
  const [privyOpen, setPrivyOpen] = useState(false);
  // Coinbase's own Apple Pay button, shown when pressing it for you didn't bring up the sheet.
  const [showCoinbaseButton, setShowCoinbaseButton] = useState(false);
  const settled = useRef(false);
  const loaded = useRef(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const cashBefore = useRef<number | null>(null);
  const alive = useRef(false);
  const webRef = useRef<WebView>(null);

  // Fresh card each time it opens.
  useEffect(() => {
    alive.current = visible;
    if (!visible) return;
    setStep('choose');
    setError(null);
    setBusy(false);
    setCode('');
    setPayUrl(null);
    setPrivyOpen(false);
    setShowCoinbaseButton(false);
    cashBefore.current = null;
    setQuote(null);
    getApplePayQuote(amount)
      .then((q) => {
        if (alive.current) setQuote(q);
      })
      .catch(() => undefined);
    getCash()
      .then((c) => {
        cashBefore.current = c;
      })
      .catch(() => undefined);
    return () => {
      alive.current = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const waitForCash = useCallback(async () => {
    setStep('waiting');
    const before = cashBefore.current ?? (await getCash().catch(() => 0));
    const started = Date.now();
    while (alive.current && Date.now() - started < WAIT_MS) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const now = await getCash().catch(() => null);
      if (now != null && now > before + 0.5) {
        track('add_cash_finished', { amount });
        if (alive.current) onPaid(now);
        return;
      }
    }
    if (alive.current) setStep('slow');
  }, [amount, onPaid]);

  // ── Apple Pay ──────────────────────────────────────────────────────────
  const apple = useCallback(async () => {
    setError(null);
    setBusy(true);
    track('add_cash_started', { amount, method: 'apple_pay' });
    try {
      const { url } = await startApplePay(amount);
      if (!alive.current) return;
      settled.current = false;
      loaded.current = false;
      setShowCoinbaseButton(false);
      setStep('opening');
      setPayUrl(url);
      // Coinbase's page never said it loaded: don't leave the person on a spinner.
      later(() => {
        if (settled.current || loaded.current) return;
        endApplePay(copy.payAppleFailed);
      }, 20_000);
    } catch (err) {
      const code = apiErrorCode(err);
      if (code === 'need_email' || code === 'need_email_code') setStep('email');
      else if (code === 'us_only') {
        setAppleOff(true);
        setError(copy.payUsOnly);
      } else if (code === 'limit') {
        setAppleOff(true);
        setError(copy.payLimit);
      } else if (code === 'bad_amount') setError(copy.payMin(usd2(APPLE_PAY_MIN_USD)));
      else setError(copy.payAppleFailed);
    } finally {
      setBusy(false);
    }
  }, [amount]);

  const sendEmail = async () => {
    setError(null);
    setBusy(true);
    try {
      await sendApplePayEmail(email.trim());
      setStep('code');
    } catch {
      setError(copy.didntGo);
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setError(null);
    setBusy(true);
    try {
      await verifyApplePayEmail(code.trim());
      setStep('choose');
      void apple();
    } catch {
      setError(copy.payCodeWrong);
    } finally {
      setBusy(false);
    }
  };

  const later = (fn: () => void, ms: number) => {
    timers.current.push(setTimeout(fn, ms));
  };
  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
    },
    [],
  );
  const endApplePay = (message: string | null) => {
    settled.current = true;
    loaded.current = false;
    setPayUrl(null);
    setShowCoinbaseButton(false);
    setStep('choose');
    setError(message);
  };

  const pressApplePay = () => {
    webRef.current?.injectJavaScript(`
      (function () {
        function tryClick(n) {
          var b = document.getElementById('api-onramp-apple-pay-button');
          if (b) b.click();
          else if (n < 10) setTimeout(function () { tryClick(n + 1); }, 500);
        }
        tryClick(1);
      })();
      true;
    `);
  };

  const onMessage = (e: WebViewMessageEvent) => {
    let name = '';
    try {
      name = String(JSON.parse(e.nativeEvent.data)?.eventName ?? '');
    } catch {
      return;
    }
    switch (name) {
      case 'onramp_api.load_success':
        loaded.current = true;
        pressApplePay();
        // Coinbase says its button must be tapped by the person. If our press
        // didn't bring up Apple Pay, show their button so they can tap it.
        later(() => {
          if (!settled.current) setShowCoinbaseButton(true);
        }, 2500);
        break;
      case 'onramp_api.commit_success':
        settled.current = true;
        setShowCoinbaseButton(false);
        track('apple_pay_paid', { amount });
        void waitForCash();
        break;
      case 'onramp_api.cancel':
        endApplePay(null);
        break;
      case 'onramp_api.load_error':
      case 'onramp_api.commit_error':
      case 'onramp_api.validate_merchant_error':
      case 'onramp_api.polling_error':
        track('apple_pay_failed', { event: name });
        endApplePay(copy.payAppleFailed);
        break;
      default:
        break;
    }
  };

  // ── Card (Privy) ───────────────────────────────────────────────────────
  // Card: hide this sheet, and only once iOS reports it gone (onDismiss) open
  // Privy's sheet; iOS won't present one sheet while another is closing.
  const cardPending = useRef(false);
  const card = () => {
    if (!wallets.wallets[0]?.address) return;
    setError(null);
    track('add_cash_started', { amount, method: 'card' });
    cardPending.current = true;
    setPrivyOpen(true);
  };

  const runCard = async () => {
    const address = wallets.wallets[0]?.address;
    if (!address) return;
    try {
      await fundWallet({
        address,
        chain: base,
        asset: 'USDC',
        amount: amount.toFixed(2),
      });
      setPrivyOpen(false);
      void waitForCash();
    } catch {
      // Privy rejects when the person closes its sheet: just come back here.
      setPrivyOpen(false);
    }
  };

  const closable = step !== 'opening' && step !== 'waiting';
  const amountLabel = usd2(amount);

  return (
    <Modal
      visible={visible && !privyOpen}
      transparent
      animationType="slide"
      onDismiss={() => {
        if (!cardPending.current) return;
        cardPending.current = false;
        void runCard();
      }}
      onRequestClose={() => {
      if (closable) onClose();
    }}>
      <Pressable
        style={styles.backdrop}
        onPress={() => {
          if (closable) onClose();
        }}
      />
      <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) + 8 }]}>
        <Text style={styles.title}>{copy.payTitle(amountLabel)}</Text>

        {step === 'choose' && (
          <>
            {!appleOff && quote ? (
              <View style={styles.breakdown}>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>{copy.payToCash}</Text>
                  <Text style={styles.rowValue}>{usd2(quote.receiveUsd)}</Text>
                </View>
                <View style={styles.row}>
                  <Text style={styles.rowLabel}>{copy.payApplePayFee}</Text>
                  <Text style={styles.rowValue}>{usd2(quote.feeUsd)}</Text>
                </View>
              </View>
            ) : null}
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <View style={styles.actions}>
              {!appleOff && (
                <Button variant="ink" loading={busy} onPress={() => void apple()}>
                  {quote ? copy.applePayTotal(usd2(quote.totalUsd)) : copy.applePay}
                </Button>
              )}
              <Button variant="secondary" disabled={busy} onPress={card}>
                {copy.payWithCard}
              </Button>
            </View>
            {!appleOff && <Text style={styles.terms}>{copy.payTerms}</Text>}
          </>
        )}

        {step === 'email' && (
          <>
            <Text style={styles.sub}>{copy.payEmailBody}</Text>
            <TextInput
              style={styles.input}
              value={email}
              onChangeText={setEmail}
              placeholder={copy.payEmailPlaceholder}
              placeholderTextColor={color.textSecondary}
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              textContentType="emailAddress"
              autoFocus
            />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Button disabled={!/\S+@\S+\.\S+/.test(email)} loading={busy} onPress={() => void sendEmail()}>
              {copy.payEmailButton}
            </Button>
          </>
        )}

        {step === 'code' && (
          <>
            <Text style={styles.sub}>{copy.payCodeBody(email.trim())}</Text>
            <TextInput
              style={styles.input}
              value={code}
              onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
              placeholder="123456"
              placeholderTextColor={color.textSecondary}
              keyboardType="number-pad"
              textContentType="oneTimeCode"
              autoComplete="one-time-code"
              autoFocus
            />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Button disabled={code.length !== 6} loading={busy} onPress={() => void verify()}>
              {copy.payCodeButton}
            </Button>
          </>
        )}

        {step === 'opening' && !showCoinbaseButton && (
          <View style={styles.center}>
            <ActivityIndicator color={color.ink} />
            <Text style={styles.sub}>{copy.payOpening}</Text>
          </View>
        )}

        {step === 'opening' && showCoinbaseButton && (
          <Text style={styles.sub}>{copy.payTapApple}</Text>
        )}

        {step === 'waiting' && (
          <View style={styles.center}>
            <ActivityIndicator color={color.ink} />
            <Text style={styles.sub}>{copy.payWaiting(amountLabel)}</Text>
            <Text style={styles.terms}>{copy.payWaitingNote}</Text>
          </View>
        )}

        {step === 'slow' && (
          <>
            <Text style={styles.sub}>{copy.payStillComing}</Text>
            <Button onPress={onClose}>{copy.done}</Button>
          </>
        )}

        {payUrl ? (
          // Coinbase's page. Hidden while we press its Apple Pay button for
          // you; shown, button-sized, if you need to tap it yourself.
          <View
            style={showCoinbaseButton && step === 'opening' ? styles.coinbaseButton : styles.hidden}
            pointerEvents={showCoinbaseButton && step === 'opening' ? 'auto' : 'none'}
          >
            <CoinbaseWebView
              ref={webRef}
              style={{ flex: 1, backgroundColor: 'transparent' }}
              source={{ uri: payUrl }}
              onMessage={onMessage}
              injectedJavaScriptBeforeContentLoaded={CB_ONRAMP_BRIDGE}
              javaScriptEnabled
              domStorageEnabled
              sharedCookiesEnabled
              thirdPartyCookiesEnabled
              allowsInlineMediaPlayback
              originWhitelist={['*']}
              setSupportMultipleWindows={false}
              javaScriptCanOpenWindowsAutomatically
              scrollEnabled={false}
            />
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(10,11,13,0.32)' },
  sheet: {
    backgroundColor: color.canvas,
    borderTopLeftRadius: radius.tile,
    borderTopRightRadius: radius.tile,
    paddingHorizontal: spacing.screenPad,
    paddingTop: 24,
    gap: 12,
  },
  title: { ...type.titleSm, color: color.ink },
  breakdown: { gap: 6, paddingVertical: 4 },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  rowLabel: { ...type.bodyRegular, color: color.textSecondary },
  rowValue: { ...type.body, color: color.ink },
  sub: { ...type.bodyRegular, color: color.textSecondary },
  actions: { gap: 10, marginTop: 4 },
  terms: { ...type.caption, color: color.textSecondary, textAlign: 'center' },
  error: { ...type.caption, color: color.moveDownInk },
  center: { alignItems: 'center', gap: 10, paddingVertical: 24 },
  input: {
    ...type.body,
    color: color.ink,
    backgroundColor: color.card,
    borderRadius: radius.card,
    paddingHorizontal: 16,
    height: 56,
  },
  // Same as Coinbase's demo: full size but invisible and behind the card.
  hidden: { ...StyleSheet.absoluteFill, opacity: 0, zIndex: -1 },
  coinbaseButton: { height: 64, borderRadius: radius.pill, overflow: 'hidden', marginTop: 4 },
});
