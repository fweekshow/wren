import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, type } from '../theme';
import { Wren } from '../components/Wren';
import { Button } from '../components/Button';
import { PinnedAction } from '../components/PinnedAction';
import { copy } from '../copy';
import { track } from '../observe';
import { getGiftStatus } from '../api';

type Props = {
  giftId: string;
  signedIn: boolean;
  onSignIn: () => void;
  onHome: () => void;
};

export function ClaimScreen({ giftId, signedIn, onSignIn, onHome }: Props) {
  const [line, setLine] = useState('A stock is on the way.');
  const [done, setDone] = useState(false);

  useEffect(() => {
    track('claim_opened', { giftId });
    let alive = true;
    const tick = async () => {
      try {
        const status = await getGiftStatus(giftId);
        if (!alive) return;
        if (status.amountLabel) setLine(status.amountLabel);
        if (status.status === 'sent' || status.delivery === 'released') {
          setDone(true);
          track('claim_completed', { giftId });
          return;
        }
      } catch {
        // The public send may still be settling.
      }
      if (alive) setTimeout(tick, 2000);
    };
    void tick();
    return () => {
      alive = false;
    };
  }, [giftId]);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.stage}>
        <Wren size={210} />
        <Text style={styles.line}>{line}</Text>
      </View>
      <PinnedAction>
        <Button onPress={signedIn || done ? onHome : onSignIn}>
          {signedIn || done ? copy.receivedHome : copy.signInButton}
        </Button>
      </PinnedAction>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.canvas },
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  line: { ...type.titleSm, color: color.ink, textAlign: 'center', paddingHorizontal: 24 },
});
