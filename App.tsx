// App root. Owns screen state, loads fonts, listens for the wren://connected
// deep link that carries the sign-in payload.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
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
import { getSession, parseConnectedUrl, setSession } from './src/auth';
import { applyDialCode, Person } from './src/contacts';
import type { Country } from './src/countries';

import { SignInScreen } from './src/screens/SignInScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { SomeoneScreen } from './src/screens/SomeoneScreen';
import { AmountScreen } from './src/screens/AmountScreen';
import { SentScreen } from './src/screens/SentScreen';
import { CountryPickerScreen } from './src/screens/CountryPickerScreen';
import { getStocks, Stock } from './src/api';

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

  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [screen, setScreen] = useState<Screen>({ name: 'home' });
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [stocks, setStocks] = useState<Stock[]>([]);
  const browserDismissed = useRef(false);

  // Initial session check.
  useEffect(() => {
    (async () => {
      const s = await getSession();
      setSignedIn(!!s);
      setReady(true);
    })();
  }, []);

  // Keep a copy of the stocks catalog so we can show the company name on Sent.
  useEffect(() => {
    if (!signedIn) return;
    (async () => {
      try {
        setStocks(await getStocks());
      } catch {
        // ignore
      }
    })();
  }, [signedIn]);

  // Deep link handling: wren://connected#user=…&token=…
  const applyUrl = useCallback(async (url: string | null | undefined) => {
    if (!url) return;
    if (!url.toLowerCase().startsWith('wren://')) return;
    const parsed = parseConnectedUrl(url);
    if (!parsed) return;
    await setSession(parsed);
    setSignedIn(true);
    if (!browserDismissed.current) {
      try {
        await WebBrowser.dismissBrowser();
      } catch {
        // noop
      }
      browserDismissed.current = true;
    }
    setScreen({ name: 'home' });
  }, []);

  useEffect(() => {
    const sub = Linking.addEventListener('url', (e) => {
      void applyUrl(e.url);
    });
    (async () => {
      const initial = await Linking.getInitialURL();
      await applyUrl(initial);
    })();
    return () => sub.remove();
  }, [applyUrl]);

  const fontsLoaded = interLoaded && monoLoaded;
  if (!ready || !fontsLoaded) {
    return (
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <View style={styles.boot} />
      </SafeAreaProvider>
    );
  }

  if (!signedIn) {
    return (
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <SignInScreen />
      </SafeAreaProvider>
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

  const pickCountry = (c: Country) => {
    if (screen.name !== 'country') return;
    const person = screen.person;
    const raw = person.phones.find((ph) => !ph.e164)?.raw ?? person.bestPhone?.raw ?? '';
    const e164 = applyDialCode(raw, c.dial);
    if (!e164) {
      setScreen({ name: 'someone' });
      return;
    }
    setScreen({ name: 'amount', person, phone: e164 });
  };

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
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
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  boot: { flex: 1, backgroundColor: color.canvas },
});
