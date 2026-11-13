// App root. Owns screen state, loads fonts, and bridges Privy's React context
// to our request client. Sign-in is native (Privy email+OTP) — no web handoff,
// no CDP. When Privy flips to "authenticated", we mirror the user's DID and
// Privy access token into SecureStore so `src/api.ts` (which runs outside the
// React tree) can read them for `/api/app/*` calls.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { PrivyProvider, usePrivy } from '@privy-io/expo';
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

import { color } from './src/theme';
import { clearSession, getSession, setSession } from './src/auth';
import { applyDialCode, Person } from './src/contacts';
import type { Country } from './src/countries';

import { SignInScreen } from './src/screens/SignInScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { SomeoneScreen } from './src/screens/SomeoneScreen';
import { AmountScreen } from './src/screens/AmountScreen';
import { SentScreen } from './src/screens/SentScreen';
import { CountryPickerScreen } from './src/screens/CountryPickerScreen';
import { getStocks, Stock } from './src/api';

// Privy app credentials come from the env. EXPO_PUBLIC_* vars are bundled into
// the JS so the client can read them; keep genuinely-secret values on the
// server. See README for setup.
const PRIVY_APP_ID = process.env.EXPO_PUBLIC_PRIVY_APP_ID ?? '';
const PRIVY_CLIENT_ID = process.env.EXPO_PUBLIC_PRIVY_CLIENT_ID;

export default function App() {
  const [interLoaded] = useInterTight({
    InterTight_400Regular,
    InterTight_500Medium,
    InterTight_600SemiBold,
  });
  const [monoLoaded] = useRobotoMono({
    RobotoMono_400Regular,
    RobotoMono_500Medium,
  });

  const fontsLoaded = interLoaded && monoLoaded;
  if (!fontsLoaded) {
    return (
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <View style={styles.boot} />
      </SafeAreaProvider>
    );
  }

  // No app id → render the gate but show no fields; this stops Privy from
  // throwing and keeps the rest of the UI inspectable in a dev build.
  if (!PRIVY_APP_ID) {
    return (
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <View style={styles.boot} />
      </SafeAreaProvider>
    );
  }

  return (
    <PrivyProvider appId={PRIVY_APP_ID} clientId={PRIVY_CLIENT_ID}>
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
  | { name: 'country'; person: Person }
  | { name: 'amount'; person: Person; phone: string }
  | {
      name: 'sent';
      giftId: string;
      personName: string;
      usd: number;
      companyName: string;
    };

function Shell() {
  const privy = usePrivy();
  const [bootChecked, setBootChecked] = useState(false);
  const [screen, setScreen] = useState<Screen>({ name: 'home' });
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [stocks, setStocks] = useState<Stock[]>([]);
  const lastSynced = useRef<string | null>(null); // the Privy user id we last stored

  // One-shot: nothing persists across launches today beyond SecureStore, so
  // mark boot-checked as soon as Privy itself reports it's ready.
  useEffect(() => {
    if (privy.isReady) setBootChecked(true);
  }, [privy.isReady]);

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
        return;
      }
      try {
        const token = await privy.getAccessToken();
        if (cancelled || !token) return;
        await setSession({ user: user.id, token });
        lastSynced.current = user.id;
      } catch {
        // Keep whatever was already in SecureStore; a stale token will 401 on
        // the next call and we'll re-sign-in.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [privy.isReady, privy.user]);

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
  if (!bootChecked) {
    return <View style={styles.boot} />;
  }
  if (!signedIn) {
    return <SignInScreen />;
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

  return (
    <>
      {screen.name === 'home' && (
        <HomeScreen onSend={() => setScreen({ name: 'someone' })} />
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
              usd,
              companyName: match?.name ?? symbol,
            });
          }}
        />
      )}
      {screen.name === 'sent' && (
        <SentScreen
          giftId={screen.giftId}
          personName={screen.personName}
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
