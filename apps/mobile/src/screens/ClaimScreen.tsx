// Claim: what they were sent, as a gray message bubble from the sender, like
// Welcome. One button: Sign in, or Home once it has landed. No illustration.

import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, layout, spacing } from '../theme';
import { TopBar } from '../components/HeaderBack';
import { BubbleCard } from '../components/BubbleCard';
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
      <TopBar />
      <View style={styles.stage}>
        <BubbleCard from="them">{line}</BubbleCard>
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
  stage: {
    flex: 1,
    paddingHorizontal: spacing.screenPad,
    paddingTop: layout.titleGap,
  },
});
