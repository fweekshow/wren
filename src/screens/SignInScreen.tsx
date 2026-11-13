// Sign in opens https://basemate.app/mobile/sign-in in the system browser.
// We never mention Basemate in copy. On return, the wren://connected deep link
// carries user + token in its fragment (parsed in auth.ts, wired in App.tsx).

import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';
import { color, type } from '../theme';
import { Button } from '../components/Button';
import { Wren } from '../components/Wren';
import { PinnedAction } from '../components/PinnedAction';

const SIGN_IN_URL = 'https://basemate.app/mobile/sign-in';

export function SignInScreen() {
  const [opening, setOpening] = useState(false);

  const start = async () => {
    try {
      setOpening(true);
      await WebBrowser.openBrowserAsync(SIGN_IN_URL);
    } finally {
      setOpening(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.hero}>
        <Wren size={150} />
        <Text style={styles.title}>Wren</Text>
        <Text style={styles.sub}>Pick someone you know and send them a stock.</Text>
      </View>
      <PinnedAction>
        <Button onPress={start} loading={opening}>
          Continue
        </Button>
      </PinnedAction>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.canvas },
  hero: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 18,
  },
  title: {
    ...type.nameLg,
    color: color.textPrimary,
    marginTop: 8,
  },
  sub: {
    ...type.bodyRegular,
    color: color.textSecondary,
    textAlign: 'center',
    marginTop: -4,
  },
});
