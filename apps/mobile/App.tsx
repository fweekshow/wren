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
import * as Linking from 'expo-linking';
import {
  useFonts as useInterTight,
  InterTight_400Regular,
  InterTight_500Medium,
  InterTight_600SemiBold,
} from '@expo-google-fonts/inter-tight';
import {
  useFonts as useRobotoMono,
  RobotoMono_400Regular,
  RobotoMono_500Medium,
} from '@expo-google-fonts/roboto-mono';

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
import { HomeScreen } from './src/screens/HomeScreen';
import { SomeoneScreen } from './src/screens/SomeoneScreen';
import { AmountScreen } from './src/screens/AmountScreen';
import { SentScreen } from './src/screens/SentScreen';
import { CountryPickerScreen } from './src/screens/CountryPickerScreen';
import { ConnectScreen } from './src/screens/ConnectScreen';
import { ClaimScreen } from './src/screens/ClaimScreen';
// Privy app id comes from the env. EXPO_PUBLIC_* vars are bundled into the JS
// so the client can read them; keep genuinely-secret values on the server.
// The dashboard client id is rejected by Privy's API, so it is not passed.
// The iOS bundle id is allowlisted on the app, and the SDK sends that itself.
const PRIVY_APP_ID = process.env.EXPO_PUBLIC_PRIVY_APP_ID ?? '';
const CONTACTS_SKIPPED = 'wren.contacts.skipped';
const CONNECT_SEEN = 'wren.connect.seen';

export default function App() {
  const [interReady, interError] = useInterTight({
    InterTight_400Regular,
    InterTight_500Medium,
    InterTight_600SemiBold,
  });
  const [monoReady, monoError] = useRobotoMono({
    RobotoMono_400Regular,
    RobotoMono_500Medium,
  });
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
      </SafeAreaProvider>
    </PrivyProvider>
  );
}

// ─── Inner tree ──────────────────────────────────────────────────────────────

type Screen =
  | { name: 'home' }
  | { name: 'someone' }
  | { name: 'connect' }
  | { name: 'country'; person: Person }
  | { name: 'amount'; person: Person; phone: string }
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
  const [screen, setScreen] = useState<Screen>({ name: 'home' });
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [allowed, setAllowed] = useState(false);
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
      if (giftId) setScreen({ name: 'claim', giftId: giftId.split('/')[0] });
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
        setScreen({ name: 'someone' });
        return;
      }
      setScreen({ name: 'amount', person, phone: e164 });
    },
    [screen],
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
          void signers
            .addSigners({ address, signers: [{ signerId, policyIds: [] }] })
            .then(() => setAllowed(true))
            .catch(() => setAllowed(true));
        }}
      />
    );
  }

  const pickPerson = (p: Person) => {
    setRecentIds((ids) => [p.id, ...ids.filter((id) => id !== p.id)].slice(0, 6));
    const best = p.bestPhone;
    if (best?.e164) {
      setScreen({ name: 'amount', person: p, phone: best.e164 });
    } else {
      // A number with no + does not open Amount. Ask which country.
      setScreen({ name: 'country', person: p });
    }
  };

  return (
    <>
      {screen.name === 'home' && (
        <HomeScreen
          onSend={() => setScreen({ name: 'someone' })}
          onConnect={() => setScreen({ name: 'connect' })}
        />
      )}
      {screen.name === 'someone' && (
        <SomeoneScreen
          onBack={() => setScreen({ name: 'home' })}
          onPick={pickPerson}
          recentIds={recentIds}
        />
      )}
      {screen.name === 'country' && (
        <CountryPickerScreen
          onBack={() => setScreen({ name: 'someone' })}
          onPick={pickCountry}
        />
      )}
      {screen.name === 'amount' && (
        <AmountScreen
          person={screen.person}
          phone={screen.phone}
          onBack={() => setScreen({ name: 'someone' })}
          onSent={({ giftId, usd, symbol }) => {
            const match = stocks.find((s) => s.symbol === symbol);
            setScreen({
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
      {screen.name === 'connect' && (
        <ConnectScreen mode="settings" onBack={() => setScreen({ name: 'home' })} />
      )}
      {screen.name === 'claim' && (
        <ClaimScreen
          giftId={screen.giftId}
          signedIn={signedIn}
          onSignIn={() => setAskSignIn(true)}
          onHome={() => setScreen({ name: 'home' })}
        />
      )}
      {screen.name === 'sent' && (
        <SentScreen
          giftId={screen.giftId}
          personName={screen.personName}
          phone={screen.phone}
          usd={screen.usd}
          companyName={screen.companyName}
          onHome={() => setScreen({ name: 'home' })}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  boot: { flex: 1, backgroundColor: color.canvas },
});

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
