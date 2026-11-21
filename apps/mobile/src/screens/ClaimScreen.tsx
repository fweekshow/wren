// Claim: what they were sent, as a gray message bubble from the sender, like
// Welcome. Opened from a /c/ link (wren://g/<giftId>).
//
// Claiming = signing into Wren with the number it was sent to; Wren then
// moves it into their account within a minute or so. So: signed out → Sign in;
// signed in → it's on its way; claimed → It's yours; returned → it went back.

import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, layout, spacing, type } from '../theme';
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

type State = 'loading' | 'waiting' | 'claimed' | 'returned';

/** "$50 of AAPLc" → "$50 of AAPL". */
const tidy = (label: string) => label.replace(/\b([A-Z]{1,6})c\b/g, '$1');

export function ClaimScreen({ giftId, signedIn, onSignIn, onHome }: Props) {
  const [line, setLine] = useState<string>(copy.claimOnTheWay);
  const [state, setState] = useState<State>('loading');

  useEffect(() => {
    track('claim_opened', { giftId });
    let alive = true;
    const tick = async () => {
      try {
        const s = await getGiftStatus(giftId);
        if (!alive) return;
        if (s.amountLabel) setLine(tidy(s.amountLabel));
        // Sent to someone already on Wren: it's in their account.
        if (s.status === 'sent' && s.alreadyOnBasemate) {
          setState('claimed');
          return;
        }
        if (s.claimState === 'claimed') {
          setState('claimed');
          track('claim_completed', { giftId });
          return;
        }
        if (s.claimState === 'returned') {
          setState('returned');
          return;
        }
        setState('waiting');
      } catch {
        // The public send may still be settling.
      }
      if (alive) setTimeout(tick, 3000);
    };
    void tick();
    return () => {
      alive = false;
    };
  }, [giftId]);

  const note =
    state === 'claimed'
      ? copy.claimDone
      : state === 'returned'
        ? copy.claimReturned
        : state === 'waiting'
          ? signedIn
            ? copy.claimLanding
            : copy.claimSignIn
          : '';
  const showSignIn = !signedIn && state === 'waiting';

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <TopBar />
      <View style={styles.stage}>
        <BubbleCard from="them">{line}</BubbleCard>
        {note ? <Text style={styles.note}>{note}</Text> : null}
      </View>
      <PinnedAction>
        <Button onPress={showSignIn ? onSignIn : onHome}>
          {showSignIn ? copy.signInButton : copy.receivedHome}
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
  note: { ...type.bodyRegular, color: color.textSecondary, marginTop: 18 },
});
