// Sent: top-aligned like every screen. "Sent to", their first name at 96, then
// the send as your blue bubble ("$50 of Apple.") with one line under it, like a
// delivered text.
//
// If they already have Wren, it's in their account and Home is the button.
// If they don't, Wren doesn't message them (WhatsApp only allows businesses to
// message people who opted in, and cold iMessages get reported). The sender is
// the messenger: the main button opens the share sheet with the link, and the
// text comes from a friend, not a business number.
// AmountScreen already waited for status === 'sent' before pushing here.

import React, { useEffect, useState } from 'react';
import { Linking, Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, layout, spacing, type } from '../theme';
import { TopBar } from '../components/HeaderBack';
import { BubbleCard } from '../components/BubbleCard';
import { Button } from '../components/Button';
import { PinnedAction } from '../components/PinnedAction';
import { copy } from '../copy';
import { formatPhone } from '../format';
import { track } from '../observe';
import { getGiftStatus } from '../api';
import { messagesUrl, whatsappUrl } from '../chatLinks';

type Props = {
  giftId: string;
  personName: string;
  phone: string; // E.164
  usd: number;
  companyName: string;
  onHome: () => void;
};

type Delivery =
  | { kind: 'loading' }
  | { kind: 'account' }
  | { kind: 'link'; url: string; holdHours: number | null };

function holdText(hours: number | null): string {
  if (!hours) return '';
  if (hours % 24 === 0) {
    const days = hours / 24;
    return copy.sentHold(days === 1 ? '1 day' : `${days} days`);
  }
  return copy.sentHold(hours === 1 ? '1 hour' : `${hours} hours`);
}



export function SentScreen({ giftId, personName, phone, usd, companyName, onHome }: Props) {
  const [delivery, setDelivery] = useState<Delivery>({ kind: 'loading' });
  const [shared, setShared] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await getGiftStatus(giftId);
        if (!alive) return;
        const url = r.shareUrl ?? r.claimUrl;
        if (url && !r.alreadyOnBasemate) {
          setDelivery({ kind: 'link', url, holdHours: r.holdHours ?? null });
        } else {
          setDelivery({ kind: 'account' });
        }
      } catch {
        if (alive) setDelivery({ kind: 'account' });
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
  const what = `${dollars} of ${companyName}`;

  // Open Messages or WhatsApp already addressed to them, message typed out.
  const openChat = async (app: 'messages' | 'whatsapp') => {
    if (delivery.kind !== 'link' || !phone) return;
    const body = copy.sentShareMessage(what, delivery.url);
    const url = app === 'messages' ? messagesUrl(phone, body) : whatsappUrl(phone, body);
    const opened = await Linking.openURL(url).then(() => true).catch(() => false);
    if (opened) {
      setShared(true);
      track('send_link_shared', { giftId, via: app });
    } else {
      void shareLink();
    }
  };

  const shareLink = async () => {
    if (delivery.kind !== 'link') return;
    try {
      const result = await Share.share({ message: copy.sentShareMessage(what, delivery.url) });
      if (result.action === Share.sharedAction) {
        setShared(true);
        track('send_link_shared', { giftId });
      }
    } catch {
      // The share sheet was dismissed or unavailable; the button stays.
    }
  };

  const needsLink = delivery.kind === 'link';
  const statusLine =
    delivery.kind === 'loading' ? '' : needsLink ? copy.sentWaiting(personName) : copy.sentInAccount;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <TopBar />
      <View style={styles.stage}>
        <Text style={styles.label}>{copy.sentTo}</Text>
        <Text style={styles.name} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5}>
          {personName}
        </Text>
        {phone ? <Text style={styles.phone}>{formatPhone(phone)}</Text> : null}
        <BubbleCard from="you" style={styles.bubble}>
          {`${what}.`}
        </BubbleCard>
        {statusLine ? <Text style={styles.line}>{statusLine}</Text> : null}
        {needsLink ? (
          <View style={styles.note}>
            <Text style={styles.noteText}>{copy.sentNotOnWren(personName)}</Text>
            {delivery.holdHours ? <Text style={styles.hold}>{holdText(delivery.holdHours)}</Text> : null}
          </View>
        ) : null}
      </View>
      <PinnedAction>
        {needsLink && !shared ? (
          <View style={styles.actions}>
            {phone ? (
              <>
                <Button onPress={() => void openChat('messages')}>{copy.sentTextTo(personName)}</Button>
                <Button variant="secondary" onPress={() => void openChat('whatsapp')}>
                  {copy.sentWhatsappTo(personName)}
                </Button>
              </>
            ) : (
              <Button onPress={() => void shareLink()}>{copy.sentShare(personName)}</Button>
            )}
            <View style={styles.smallRow}>
              {phone ? (
                <Pressable onPress={() => void shareLink()} hitSlop={10} accessibilityRole="button">
                  <Text style={styles.smallLink}>{copy.sentMoreWays}</Text>
                </Pressable>
              ) : null}
              <Pressable onPress={onHome} hitSlop={10} accessibilityRole="button">
                <Text style={styles.smallLink}>{copy.sentNotNow}</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <View style={styles.actions}>
            <Button onPress={onHome}>{copy.sentHome}</Button>
            {needsLink ? (
              <Button variant="ghost" onPress={() => void shareLink()}>
                {copy.sentShareAgain}
              </Button>
            ) : null}
          </View>
        )}
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
  phone: { ...type.price, color: color.textSecondary, marginTop: 8 },
  bubble: { marginTop: 36 },
  line: {
    ...type.caption,
    color: color.textSecondary,
    alignSelf: 'flex-end',
    marginTop: 8,
  },
  note: { marginTop: 32, gap: 8 },
  noteText: { ...type.body, color: color.ink },
  hold: { ...type.caption, color: color.textSecondary },
  actions: { gap: 10 },
  smallRow: { flexDirection: 'row', justifyContent: 'center', gap: 28, paddingTop: 6 },
  smallLink: { ...type.label, color: color.textSecondary },
});
