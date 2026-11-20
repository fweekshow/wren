// Sent: top-aligned like every screen. "Sent to", their first name at 96, then the send as your blue bubble
// ("$50 of Apple.") with one line under it ("Text sent" / "It's in their
// Wren."), like a delivered text. Home is the only button. No illustration.
// AmountScreen already waited for status === 'sent' before pushing here.

import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, layout, spacing, type } from '../theme';
import { TopBar } from '../components/HeaderBack';
import { BubbleCard } from '../components/BubbleCard';
import { Button } from '../components/Button';
import { PinnedAction } from '../components/PinnedAction';
import { copy } from '../copy';
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
  const [line, setLine] = useState<string>(copy.sentText);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await getGiftStatus(giftId);
        if (!alive) return;
        if (r.delivery === 'whatsapp') setLine(copy.sentWhatsapp);
        else if (r.delivery === 'template' || r.claimUrl) setLine(copy.sentInvite);
        else setLine(r.alreadyOnBasemate ? "It's in their Wren." : copy.sentText);
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
      <TopBar />
      <View style={styles.stage}>
        <Text style={styles.label}>{copy.sentTo}</Text>
        <Text style={styles.name} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5}>
          {personName}
        </Text>
        <BubbleCard from="you" style={styles.bubble}>
          {`${dollars} of ${companyName}.`}
        </BubbleCard>
        <Text style={styles.line}>{line}</Text>
      </View>
      <PinnedAction>
        <Button onPress={onHome}>{copy.sentHome}</Button>
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
  label: {
    ...type.bodyRegular,
    color: color.textSecondary,
  },
  name: {
    ...type.nameXl,
    color: color.ink,
    marginTop: 6,
  },
  bubble: { marginTop: 36 },
  line: {
    ...type.caption,
    color: color.textSecondary,
    alignSelf: 'flex-end',
    marginTop: 8,
  },
});
