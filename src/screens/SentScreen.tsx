// Sent: the bird on the halo, first name, dollars + company, then one line
// ("It's in their Wren." / "They'll get a text."). Home is the only button.
// AmountScreen already waited for status === 'sent' before pushing here.

import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, type } from '../theme';
import { Wren } from '../components/Wren';
import { Button } from '../components/Button';
import { PinnedAction } from '../components/PinnedAction';
import { getGiftStatus } from '../api';

type Props = {
  giftId: string;
  personName: string;
  usd: number;
  companyName: string;
  onHome: () => void;
};

export function SentScreen({ giftId, personName, usd, companyName, onHome }: Props) {
  // We already know the status is "sent" when we land here, but refresh once
  // so alreadyOnBasemate reflects the final value the server recorded.
  const [alreadyOnBasemate, setAlreadyOnBasemate] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await getGiftStatus(giftId);
        if (!alive) return;
        setAlreadyOnBasemate(r.alreadyOnBasemate);
      } catch {
        // Fall back to the default copy.
      }
    })();
    return () => {
      alive = false;
    };
  }, [giftId]);

  const dollars = `$${usd.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.stage}>
        <View style={styles.halo}>
          <Wren size={210} style={{ marginTop: -20 }} />
        </View>
        <Text style={styles.name}>{personName}</Text>
        <Text style={styles.sub}>
          {dollars} {companyName}
        </Text>
        <Text style={styles.line}>
          {alreadyOnBasemate ? "It's in their Wren." : "They'll get a text."}
        </Text>
      </View>
      <PinnedAction>
        <Button onPress={onHome}>Home</Button>
      </PinnedAction>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.canvas },
  stage: {
    flex: 1,
    alignItems: 'center',
    paddingTop: 100,
  },
  halo: {
    width: 260,
    height: 260,
    borderRadius: 130,
    backgroundColor: color.wrenTint,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 40,
  },
  name: {
    ...type.nameLg,
    color: color.textPrimary,
  },
  sub: {
    ...type.bodyRegular,
    color: color.textSecondary,
    marginTop: 12,
  },
  line: {
    ...type.bodyRegular,
    color: color.textSecondary,
    marginTop: 4,
  },
});
