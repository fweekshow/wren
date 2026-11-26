// App root. Owns screen state, loads fonts, and bridges Privy's React context
// to our request client. Sign-in is native: Privy phone in the US and Canada,
// Privy email elsewhere (their number is confirmed in Connect). No web handoff,
// no CDP. When Privy flips to "authenticated", we mirror the user's DID and
// Privy access token into SecureStore so `src/api.ts` (which runs outside the
// React tree) can read them for `/api/app/*` calls.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { PrivyProvider, useEmbeddedEthereumWallet, usePrivy, useSigners } from '@privy-io/expo';
import { PrivyElements } from '@privy-io/expo/ui';
import * as Linking from 'expo-linking';
import {
  useFonts as useBricolage,
  BricolageGrotesque_400Regular,
  BricolageGrotesque_500Medium,
  BricolageGrotesque_700Bold,
  BricolageGrotesque_800ExtraBold,
} from '@expo-google-fonts/bricolage-grotesque';
import { useFonts as useDMMono, DMMono_400Regular, DMMono_500Medium } from '@expo-google-fonts/dm-mono';

import { clearSession, getSession, setSession } from './src/auth';
import { applyDialCode, getContactsPermission, Person } from './src/contacts';
import type { Country } from './src/countries';
import {
  exchangePrivySession,
  getConnectState,
  getStocks,
  registerPushToken,
  Stock,
  type PendingConnect,
} from './src/api';
import { track } from './src/observe';
import { color } from './src/theme';

import { SignInScreen } from './src/screens/SignInScreen';
import { AllowScreen } from './src/screens/AllowScreen';
import { ContactsScreen } from './src/screens/ContactsScreen';
import { AccountScreen, HomeTab } from './src/screens/AccountScreen';
import { StockPickScreen } from './src/screens/StockPickScreen';
import { StockScreen } from './src/screens/StockScreen';
import { BuyScreen } from './src/screens/BuyScreen';
import { BoughtScreen } from './src/screens/BoughtScreen';
import { ActivityScreen } from './src/screens/ActivityScreen';
import { ProfileScreen } from './src/screens/ProfileScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { SomeoneScreen } from './src/screens/SomeoneScreen';
import { AmountScreen } from './src/screens/AmountScreen';
import { SentScreen } from './src/screens/SentScreen';
import { CountryPickerScreen } from './src/screens/CountryPickerScreen';
import { ConnectScreen } from './src/screens/ConnectScreen';
import { ClaimScreen } from './src/screens/ClaimScreen';
import { AddCashScreen } from './src/screens/AddCashScreen';
// Privy app id comes from the env. EXPO_PUBLIC_* vars are bundled into the JS
// so the client can read them; keep genuinely-secret values on the server.
// The dashboard client id is rejected by Privy's API, so it is not passed.
// The iOS bundle id is allowlisted on the app, and the SDK sends that itself.
const PRIVY_APP_ID = process.env.EXPO_PUBLIC_PRIVY_APP_ID ?? '';
const CONTACTS_SKIPPED = 'wren.contacts.skipped';
const CONNECT_SEEN = 'wren.connect.seen';

// SecureStore keys allow letters, digits, '.', '-' and '_'.
const allowKey = (address: string) => `wren.allowed.${address.toLowerCase()}`;
const ALLOW_TIMEOUT_MS = 15_000;

export default function App() {
  const [interReady, interError] = useBricolage({
    BricolageGrotesque_400Regular,
    BricolageGrotesque_500Medium,
    BricolageGrotesque_700Bold,
    BricolageGrotesque_800ExtraBold,
  });
  const [monoReady, monoError] = useDMMono({ DMMono_400Regular, DMMono_500Medium });
  // Text drawn before the fonts land stays in the system face, so wait.
  // A font error falls through to the system face rather than a blank app.
  const fontsSettled = (interReady || !!interError) && (monoReady || !!monoError);

  // No app id → render the gate but show no fields; this stops Privy from
  // throwing and keeps the rest of the UI inspectable in a dev build.
  if (!PRIVY_APP_ID || !fontsSettled) {
    return (
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <View style={styles.boot} />
      </SafeAreaProvider>
    );
  }

  return (
    <PrivyProvider appId={PRIVY_APP_ID}>
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <Shell />
        {/* Privy's own sheets (Add cash funding). */}
        <PrivyElements />
      </SafeAreaProvider>
    </PrivyProvider>
  );
}

// ─── Inner tree ──────────────────────────────────────────────────────────────

type Screen =
  | { name: 'home' }
  | { name: 'someone'; symbol?: string }
  // What are you sending/buying? `who` = the person is already known;
  // `replace` = Change from Amount/Buy: put the pick back on that screen.
  | { name: 'what'; purpose: 'send' | 'buy' | 'browse'; who?: { name: string; phone: string }; replace?: boolean }
  | { name: 'connect' }
  | { name: 'addCash' }
  | { name: 'stock'; stock: Stock }
  | { name: 'buy'; symbol?: string }
  | { name: 'bought'; usd: number; symbol: string; stockName: string }
  | { name: 'activity' }
  | { name: 'profile'; phone: string; personName?: string }
  | { name: 'settings' }
  | { name: 'country'; person: Person; symbol?: string }
  | { name: 'amount'; person: Person; phone: string; symbol?: string }
  | { name: 'claim'; giftId: string }
  | {
      name: 'sent';
      giftId: string;
      personName: string;
      phone: string;
      usd: number;
      companyName: string;
    };

function Shell() {
  const privy = usePrivy();
  const wallets = useEmbeddedEthereumWallet();
  const signers = useSigners();
  // A small back stack: go() pushes, back() pops, home() resets.
  const [stack, setStack] = useState<Screen[]>([{ name: 'home' }]);
  const screen = stack[stack.length - 1];
  const go = useCallback((s: Screen) => setStack((st) => [...st, s]), []);
  const back = useCallback(() => setStack((st) => (st.length > 1 ? st.slice(0, -1) : st)), []);
  const home = useCallback(() => setStack([{ name: 'home' }]), []);
  // Replace the top screen (Amount → Sent, Buy → It's yours) so Back skips it.
  const swap = useCallback((s: Screen) => setStack((st) => [...st.slice(0, -1), s]), []);
  const [homeTab, setHomeTab] = useState<HomeTab>('account');
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [allowed, setAllowed] = useState(false);
  const [allowing, setAllowing] = useState(false);
  const walletAddress = wallets.wallets[0]?.address;
  // Remember on this phone that this wallet already let Wren finish sends, so
  // the screen isn't asked again on every launch.
  useEffect(() => {
    if (!walletAddress) return;
    void SecureStore.getItemAsync(allowKey(walletAddress))
      .then((v) => v === '1' && setAllowed(true))
      .catch(() => undefined);
  }, [walletAddress]);
  const lastSynced = useRef<string | null>(null);
  // loading → ready, or needsPhone when an email sign-in still has to text Wren.
  const [sessionState, setSessionState] = useState<'loading' | 'ready' | 'needsPhone'>('loading');
  const [pending, setPending] = useState<PendingConnect | null>(null);
  const [exchangeNonce, setExchangeNonce] = useState(0);
  const [connectGate, setConnectGate] = useState<'pending' | 'ask' | 'done'>('pending');

  // Keep SecureStore in sync with Privy. When Privy says we're signed in, grab
  // an access token and save it alongside the user DID — api.ts reads from
  // SecureStore, so every API call picks up the latest token on the next tick.
  // When Privy signs out, clear SecureStore too.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!privy.isReady) return;
      const user = privy.user;
      if (!user) {
        if (lastSynced.current) {
          await clearSession();
          lastSynced.current = null;
        }
        setPending(null);
        setSessionState('loading');
        return;
      }
      try {
        const accessToken = await privy.getAccessToken();
        if (cancelled || !accessToken) return;
        let address: string | undefined;
        if (wallets.wallets.length === 0) {
          await wallets.create().catch(() => undefined);
        }
        address = wallets.wallets[0]?.address;
        const result = await exchangePrivySession(accessToken, address);
        if (cancelled) return;
        if (result.kind === 'needsPhone') {
          setPending(result.connect);
          setSessionState('needsPhone');
          return;
        }
        await setSession(result.session);
        lastSynced.current = user.id;
        setPending(null);
        setSessionState('ready');
        track('sign_in_completed');
        void registerPush().catch(() => undefined);
      } catch {
        // Keep whatever was already in SecureStore; a stale token will 401 on
        // the next call and we'll re-sign-in.
        if (!cancelled) setSessionState('ready');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [privy.isReady, privy.user, exchangeNonce]);

  // Connect once after sign-in, unless a channel is already on.
  useEffect(() => {
    if (sessionState !== 'ready') {
      setConnectGate('pending');
      return;
    }
    let cancelled = false;
    (async () => {
      const seen = await SecureStore.getItemAsync(CONNECT_SEEN);
      if (seen) {
        if (!cancelled) setConnectGate('done');
        return;
      }
      const state = await getConnectState().catch(() => null);
      if (cancelled) return;
      const on = !!state?.imessageOptedInAt || !!state?.whatsappOptedInAt;
      setConnectGate(on ? 'done' : 'ask');
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionState]);

  const finishConnect = useCallback(() => {
    void SecureStore.setItemAsync(CONNECT_SEEN, '1');
    setConnectGate('done');
  }, []);

  // Load the stocks catalog so Sent can show the company name next to the $.
  // Gated on signed-in to avoid a 401 round-trip.
  useEffect(() => {
    if (!privy.user) return;
    (async () => {
      try {
        setStocks(await getStocks());
      } catch {
        // noop — Amount will also fetch stocks for its pill row.
      }
    })();
  }, [privy.user]);

  // A tiny sanity check: if SecureStore somehow has a session Privy doesn't
  // know about (e.g. left over from a previous build), log out to reconcile.
  useEffect(() => {
    (async () => {
      if (!privy.isReady) return;
      if (privy.user) return;
      const stale = await getSession();
      if (stale) await clearSession();
    })();
  }, [privy.isReady, privy.user]);

  const signedIn = !!privy.user;
  const [askSignIn, setAskSignIn] = useState(false);
  const [contactsGate, setContactsGate] = useState<'pending' | 'ask' | 'done'>('pending');

  useEffect(() => {
    if (!signedIn) {
      setContactsGate('pending');
      return;
    }
    let cancelled = false;
    (async () => {
      const current = await getContactsPermission();
      if (cancelled) return;
      if (current.granted || !current.canAskAgain) {
        setContactsGate('done');
        return;
      }
      const skipped = await SecureStore.getItemAsync(CONTACTS_SKIPPED);
      if (!cancelled) setContactsGate(skipped ? 'done' : 'ask');
    })();
    return () => {
      cancelled = true;
    };
  }, [signedIn]);

  useEffect(() => {
    const open = (url: string) => {
      const parsed = Linking.parse(url);
      const path = parsed.path ?? '';
      const giftId =
        parsed.hostname === 'g'
          ? path.replace(/^\//, '')
          : path.startsWith('g/')
            ? path.slice(2)
            : '';
      if (giftId) setStack((st) => [...st, { name: 'claim', giftId: giftId.split('/')[0] }]);
    };
    void Linking.getInitialURL().then((url) => {
      if (url) open(url);
    });
    const sub = Linking.addEventListener('url', ({ url }) => open(url));
    return () => sub.remove();
  }, []);

  const pickCountry = useCallback(
    (c: Country) => {
      if (screen.name !== 'country') return;
      const person = screen.person;
      const raw =
        person.phones.find((ph) => !ph.e164)?.raw ??
        person.bestPhone?.raw ??
        '';
      const e164 = applyDialCode(raw, c.dial);
      if (!e164) {
        back();
        return;
      }
      swap({ name: 'amount', person, phone: e164, symbol: screen.symbol });
    },
    [screen, back, swap],
  );

  if (!signedIn && (screen.name !== 'claim' || askSignIn)) {
    return <SignInScreen />;
  }
  if (signedIn && sessionState === 'needsPhone' && pending) {
    return (
      <ConnectScreen
        mode="verify"
        pending={pending}
        onVerified={(session) => {
          void (async () => {
            await setSession(session);
            await SecureStore.setItemAsync(CONNECT_SEEN, '1');
            lastSynced.current = privy.user?.id ?? null;
            setPending(null);
            setSessionState('ready');
            track('sign_in_completed', { via: 'email' });
            void registerPush().catch(() => undefined);
          })();
        }}
        onExpired={() => setExchangeNonce((n) => n + 1)}
        onSignOut={() => void privy.logout()}
      />
    );
  }
  if (signedIn && (sessionState === 'loading' || connectGate === 'pending')) {
    return <View style={styles.boot} />;
  }
  if (signedIn && connectGate === 'ask') {
    return <ConnectScreen mode="onboarding" onDone={finishConnect} />;
  }
  if (signedIn && contactsGate === 'pending') {
    return <View style={styles.boot} />;
  }
  if (signedIn && contactsGate === 'ask') {
    return (
      <ContactsScreen
        onDone={() => setContactsGate('done')}
        onSkip={() => {
          void SecureStore.setItemAsync(CONTACTS_SKIPPED, '1');
          setContactsGate('done');
        }}
      />
    );
  }
  if (signedIn && !allowed && process.env.EXPO_PUBLIC_PRIVY_SIGNER_ID && wallets.wallets[0]) {
    return (
      <AllowScreen
        onAllow={() => {
          const address = wallets.wallets[0]?.address;
          const signerId = process.env.EXPO_PUBLIC_PRIVY_SIGNER_ID;
          if (!address || !signerId) {
            setAllowed(true);
            return;
          }
          setAllowing(true);
          // Privy can leave this hanging; never strand someone on this screen.
          const timeout = new Promise((resolve) => setTimeout(resolve, ALLOW_TIMEOUT_MS));
          // Privy can hang or error when the signer is already on the wallet, and
          // this screen has always moved on either way, so remember it either way:
          // a send without the signer fails with its own clear error.
          void Promise.race([signers.addSigners({ address, signers: [{ signerId, policyIds: [] }] }), timeout])
            .catch(() => undefined)
            .finally(() => {
              void SecureStore.setItemAsync(allowKey(address), '1').catch(() => undefined);
              setAllowing(false);
              setAllowed(true);
            });
        }}
        busy={allowing}
      />
    );
  }

  const pickPerson = (p: Person, symbol?: string) => {
    setRecentIds((ids) => [p.id, ...ids.filter((id) => id !== p.id)].slice(0, 6));
    const best = p.bestPhone;
    if (best?.e164) {
      swap({ name: 'amount', person: p, phone: best.e164, symbol });
    } else {
      // A number with no + does not open Amount. Ask which country.
      swap({ name: 'country', person: p, symbol });
    }
  };

  // Send to someone Wren already knows (People tab, a profile): straight to Amount.
  const sendTo = (who: { name: string; phone: string }, symbol?: string) => {
    if (symbol) go({ name: 'amount', person: personFrom(who.name, who.phone), phone: who.phone, symbol });
    else go({ name: 'what', purpose: 'send', who });
  };

  const pickStock = (w: Extract<Screen, { name: 'what' }>, stock: Stock) => {
    const symbol = stock.symbol;
    if (w.purpose === 'browse') {
      go({ name: 'stock', stock });
      return;
    }
    if (w.replace) {
      // Pop the picker and set the stock on the screen under it.
      setStack((st) => {
        const below = st.slice(0, -1);
        const top = below[below.length - 1];
        return top && (top.name === 'amount' || top.name === 'buy')
          ? [...below.slice(0, -1), { ...top, symbol }]
          : below;
      });
    } else if (w.purpose === 'buy') go({ name: 'buy', symbol });
    else if (w.who) go({ name: 'amount', person: personFrom(w.who.name, w.who.phone), phone: w.who.phone, symbol });
    else go({ name: 'someone', symbol });
  };

  return (
    <>
      {screen.name === 'home' && (
        <AccountScreen
          tab={homeTab}
          onTab={setHomeTab}
          onSend={() => go({ name: 'what', purpose: 'send' })}
          onBuy={() => go({ name: 'what', purpose: 'buy' })}
          onOpenStock={(stock) => go({ name: 'stock', stock })}
          onAllStocks={() => go({ name: 'what', purpose: 'browse' })}
          onSettings={() => go({ name: 'settings' })}
          onActivity={() => go({ name: 'activity' })}
          onConnect={() => go({ name: 'connect' })}
          onOpenPerson={(phone, personName) => go({ name: 'profile', phone, personName })}
          onSendTo={(p) => sendTo(p)}
        />
      )}
      {screen.name === 'stock' && (
        <StockScreen
          stock={screen.stock}
          onBack={back}
          onBuy={() => go({ name: 'buy', symbol: screen.stock.symbol })}
          onSend={() => go({ name: 'someone', symbol: screen.stock.symbol })}
        />
      )}
      {screen.name === 'buy' && (
        <BuyScreen
          initialSymbol={screen.symbol}
          onBack={back}
          onChangeStock={() => go({ name: 'what', purpose: 'buy', replace: true })}
          onBought={(r) =>
            swap({ name: 'bought', usd: r.usd, symbol: r.symbol, stockName: r.stockName })
          }
        />
      )}
      {screen.name === 'bought' && (
        <BoughtScreen
          usd={screen.usd}
          stockName={screen.stockName}
          onHome={home}
          onSend={() => swap({ name: 'someone', symbol: screen.symbol })}
        />
      )}
      {screen.name === 'activity' && (
        <ActivityScreen
          onBack={back}
          onSend={() => go({ name: 'what', purpose: 'send' })}
          onOpenPerson={(phone, personName) => go({ name: 'profile', phone, personName })}
        />
      )}
      {screen.name === 'profile' && (
        <ProfileScreen
          phone={screen.phone}
          fallbackName={screen.personName}
          onBack={back}
          onSend={(p) => sendTo(p)}
        />
      )}
      {screen.name === 'settings' && (
        <SettingsScreen
          onBack={back}
          onConnect={() => go({ name: 'connect' })}
          onAddCash={() => go({ name: 'addCash' })}
          onSignOut={() => {
            home();
            void privy.logout();
          }}
        />
      )}
      {screen.name === 'what' && (
        <StockPickScreen purpose={screen.purpose} onBack={back} onPick={(st) => pickStock(screen, st)} />
      )}
      {screen.name === 'someone' && (
        <SomeoneScreen
          onBack={back}
          onPick={(p) => pickPerson(p, screen.symbol)}
          recentIds={recentIds}
        />
      )}
      {screen.name === 'country' && (
        <CountryPickerScreen
          onBack={back}
          onPick={pickCountry}
        />
      )}
      {screen.name === 'amount' && (
        <AmountScreen
          person={screen.person}
          phone={screen.phone}
          initialSymbol={screen.symbol}
          onBack={back}
          onChangeStock={() => go({ name: 'what', purpose: 'send', replace: true })}
          onSent={({ giftId, usd, symbol }) => {
            const match = stocks.find((s) => s.symbol === symbol);
            swap({
              name: 'sent',
              giftId,
              personName: screen.person.firstName,
              phone: screen.phone,
              usd,
              companyName: match?.name ?? symbol,
            });
          }}
        />
      )}
      {screen.name === 'addCash' && (
        <AddCashScreen onBack={back} onAdded={() => back()} />
      )}
      {screen.name === 'connect' && (
        <ConnectScreen mode="settings" onBack={back} />
      )}
      {screen.name === 'claim' && (
        <ClaimScreen
          giftId={screen.giftId}
          signedIn={signedIn}
          onSignIn={() => setAskSignIn(true)}
          onHome={home}
        />
      )}
      {screen.name === 'sent' && (
        <SentScreen
          giftId={screen.giftId}
          personName={screen.personName}
          phone={screen.phone}
          usd={screen.usd}
          companyName={screen.companyName}
          onHome={home}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  boot: { flex: 1, backgroundColor: color.canvas },
});

function personFrom(name: string, phone: string): Person {
  const [firstName, ...rest] = name.trim().split(/\s+/);
  const lastName = rest.join(' ');
  const option = { raw: phone, e164: phone };
  return {
    id: `wren:${phone}`,
    firstName: firstName || name,
    lastName,
    phones: [option],
    bestPhone: option,
    firstLower: (firstName || name).toLowerCase(),
    lastLower: lastName.toLowerCase(),
    hasE164: true,
  };
}

async function registerPush(): Promise<void> {
  try {
    const load = new Function('specifier', 'return import(specifier)') as (
      specifier: string,
    ) => Promise<{
      getPermissionsAsync: () => Promise<{ granted: boolean }>;
      requestPermissionsAsync: () => Promise<{ granted: boolean }>;
      getExpoPushTokenAsync: () => Promise<{ data: string }>;
    }>;
    const Notifications = await load('expo-notifications');
    const current = await Notifications.getPermissionsAsync();
    const granted = current.granted || (await Notifications.requestPermissionsAsync()).granted;
    if (!granted) return;
    const token = await Notifications.getExpoPushTokenAsync();
    if (token.data) await registerPushToken(token.data);
  } catch {
    // Push is optional until a dev build includes the module.
  }
}
