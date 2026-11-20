// After a Buy: "It's yours." and "Send it to someone?" — buying turns into
// a gift. Who sees your moves lives in Settings (new accounts: Your people).

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, spacing, type } from '../theme';
import { TopBar } from '../components/HeaderBack';
import { Button } from '../components/Button';
import { copy } from '../copy';
import { usdShort } from '../format';

type Props = {
  usd: number;
  stockName: string;
  onHome: () => void;
  onSend: () => void;
};

export function BoughtScreen({ usd, stockName, onHome, onSend }: Props) {
  return (
    <SafeAreaView style={styles.safe}>
      <TopBar />
      <View style={styles.yours}>
        <Text style={styles.yoursTitle}>{copy.itsYours}</Text>
        <Text style={styles.yoursSub}>{copy.boughtWhat(usdShort(usd), stockName)}</Text>
      </View>
      <View style={styles.footer}>
        <Text style={styles.ask}>{copy.sendItToSomeone}</Text>
        <Button variant="ghost" onPress={onHome}>
          {copy.home}
        </Button>
        <Button onPress={onSend}>{copy.send}</Button>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.canvas },
  yours: { flex: 1, alignItems: 'center', paddingTop: 96, paddingHorizontal: spacing.screenPad },
  yoursTitle: { ...type.nameLg, color: color.ink },
  yoursSub: { ...type.body, color: color.textSecondary, marginTop: 14, textAlign: 'center' },
  footer: {
    position: 'absolute',
    left: spacing.screenPad,
    right: spacing.screenPad,
    bottom: spacing.homeIndicator,
    gap: 8,
  },
  ask: { ...type.body, color: color.ink, textAlign: 'center', marginBottom: 8 },
});
