// Connect: "Where do your people text?" Two bubble tiles, iMessage and
// WhatsApp. Tapping one opens that app with Wren's text ready
// ("Turn on Wren · 4F2K9Q"); the channel turns on when the text lands.
//
// Three modes:
// - onboarding: after phone sign-in, once.
// - verify: after email sign-in (outside the US). The text is also what
//   confirms their number, so we poll until the server sees it.
// - settings: from Home.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, font, spacing, type } from '../theme';
import { Button } from '../components/Button';
import { BubbleCard } from '../components/BubbleCard';
import { ChannelTile } from '../components/ChannelTile';
import { HeaderBack } from '../components/HeaderBack';
import { PinnedAction } from '../components/PinnedAction';
import { copy } from '../copy';
import { track } from '../observe';
import type { Session } from '../auth';
import {
  ConnectState,
  ConnectTargets,
  getConnectState,
  getConnectTargets,
  pollConnectCode,
  turnOffChannel,
  type PendingConnect,
} from '../api';

type Channel = 'imessage' | 'whatsapp';

type Props =
  | { mode: 'settings'; onBack: () => void }
  | { mode: 'onboarding'; onDone: () => void }
  | {
      mode: 'verify';
      pending: PendingConnect;
      onVerified: (session: Session) => void;
      onExpired: () => void;
      onSignOut: () => void;
    };

const APP_NAME: Record<Channel, string> = { imessage: 'Messages', whatsapp: 'WhatsApp' };
const CHANNEL_NAME: Record<Channel, string> = { imessage: 'iMessage', whatsapp: 'WhatsApp' };
const POLL_MS = 2000;

export function ConnectScreen(props: Props) {
  const verify = props.mode === 'verify';
  const [state, setState] = useState<ConnectState | null>(null);
  const [targets, setTargets] = useState<ConnectTargets | null>(verify ? props.pending.targets : null);
  const [waiting, setWaiting] = useState<Channel | null>(null);
  const [verifiedOn, setVerifiedOn] = useState<Channel | null>(null);
  const doneRef = useRef(false);
  const waitingRef = useRef<Channel | null>(null);
  waitingRef.current = waiting;

  const refresh = useCallback(async () => {
    if (verify) return;
    try {
      setState(await getConnectState());
    } catch {
      // Keep the last state.
    }
  }, [verify]);

  useEffect(() => {
    void refresh();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  // Signed-in people get a code for their own number.
  useEffect(() => {
    if (verify) return;
    void getConnectTargets()
      .then(setTargets)
      .catch(() => undefined);
  }, [verify]);

  // Email sign-in: wait for the text, then hand back the session.
  useEffect(() => {
    if (props.mode !== 'verify') return;
    const { pending, onVerified, onExpired } = props;
    let stopped = false;
    const tick = async () => {
      try {
        const result = await pollConnectCode(pending.code, pending.secret);
        if (stopped || doneRef.current) return;
        if (result.status === 'done') {
          doneRef.current = true;
          track('connect_verified');
          setVerifiedOn((ch) => ch ?? waitingRef.current ?? 'imessage');
          onVerified(result.session);
          return;
        }
        if (result.status === 'expired') {
          doneRef.current = true;
          onExpired();
          return;
        }
      } catch {
        // Try again on the next tick.
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    };
    let timer = setTimeout(tick, POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.mode]);

  // Once the text lands, leave the waiting view.
  const isOn = (ch: Channel) =>
    verifiedOn === ch ||
    (ch === 'imessage' ? !!state?.imessageOptedInAt : !!state?.whatsappOptedInAt);
  useEffect(() => {
    if (waiting && isOn(waiting)) setWaiting(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, verifiedOn, waiting]);

  const open = async (channel: Channel) => {
    let current = targets;
    if (!current && !verify) {
      try {
        current = await getConnectTargets();
        setTargets(current);
      } catch {
        return;
      }
    }
    const target = current?.[channel];
    if (!target?.number) return;
    const digits = target.number.replace(/[^\d]/g, '');
    const url =
      channel === 'imessage'
        ? `sms:${digits}&body=${encodeURIComponent(target.prefill)}`
        : `https://wa.me/${digits}?text=${encodeURIComponent(target.prefill)}`;
    setWaiting(channel);
    track('connect_open', { channel, mode: props.mode });
    await Linking.openURL(url).catch(() => undefined);
  };

  const tapTile = (channel: Channel) => {
    if (!isOn(channel)) {
      void open(channel);
      return;
    }
    if (props.mode !== 'settings') return;
    Alert.alert(`Turn off ${CHANNEL_NAME[channel]}?`, undefined, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: copy.turnOff,
        style: 'destructive',
        onPress: () => void turnOffChannel(channel).then(refresh),
      },
    ]);
  };

  // ── Waiting for the text ────────────────────────────────────────────────
  if (waiting) {
    const prefill = targets?.[waiting]?.prefill ?? '';
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <HeaderBack onBack={() => setWaiting(null)} />
        <View style={styles.body}>
          <Text style={styles.headline}>Hit send in {APP_NAME[waiting]}.</Text>
          <Text style={styles.sub}>{verify ? copy.connectWaitVerify : copy.connectWaitBody}</Text>
          {prefill ? <BubbleCard from="you" style={styles.preview}>{prefill}</BubbleCard> : null}
          <Text style={styles.toWren}>
            {copy.connectToWren} · {copy.connectWaiting}
          </Text>
        </View>
        <PinnedAction>
          <View style={styles.actions}>
            <Button onPress={() => void open(waiting)}>Open {APP_NAME[waiting]}</Button>
            <Button variant="ghost" onPress={() => setWaiting(null)}>
              {copy.connectNotNow}
            </Button>
          </View>
        </PinnedAction>
      </SafeAreaView>
    );
  }

  // ── Tiles ───────────────────────────────────────────────────────────────
  const onChannel: Channel | null = isOn('whatsapp') ? 'whatsapp' : isOn('imessage') ? 'imessage' : null;
  const headline = onChannel ? `You’re on ${CHANNEL_NAME[onChannel]}.` : copy.connectAsk;
  const sub = onChannel ? copy.connectOnBody : verify ? copy.connectAskVerify : copy.connectAskBody;
  const tileSub = (ch: Channel) =>
    isOn(ch)
      ? props.mode === 'settings'
        ? copy.connectOnTapOff
        : copy.connectOn
      : `Opens ${APP_NAME[ch]}. ${copy.connectOpens}`;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {props.mode === 'settings' ? <HeaderBack onBack={props.onBack} /> : <View style={styles.topGap} />}
      <View style={styles.body}>
        <Text style={styles.headline}>{headline}</Text>
        <Text style={styles.sub}>{sub}</Text>
        <View style={styles.tiles}>
          {(['imessage', 'whatsapp'] as Channel[]).map((ch) => (
            <ChannelTile key={ch} name={CHANNEL_NAME[ch]} sub={tileSub(ch)} on={isOn(ch)} onPress={() => tapTile(ch)} />
          ))}
        </View>
      </View>
      {props.mode === 'onboarding' ? (
        <PinnedAction>
          <View style={styles.actions}>
            <Text style={styles.note}>{copy.connectBoth}</Text>
            {onChannel ? (
              <Button onPress={props.onDone}>{copy.signInContinue}</Button>
            ) : (
              <Button variant="ghost" onPress={props.onDone}>
                {copy.connectNotNow}
              </Button>
            )}
          </View>
        </PinnedAction>
      ) : null}
      {props.mode === 'verify' ? (
        <PinnedAction>
          <Pressable onPress={props.onSignOut} accessibilityRole="button" style={styles.signOut}>
            <Text style={styles.signOutText}>{copy.connectSignOut}</Text>
          </Pressable>
        </PinnedAction>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.canvas },
  topGap: { height: 20 },
  body: { paddingHorizontal: spacing.screenPad, paddingTop: 12 },
  headline: { ...type.headline, color: color.ink },
  sub: { ...type.bodyRegular, color: color.textSecondary, marginTop: 14 },
  tiles: { marginTop: 28, gap: 12 },
  preview: { marginTop: 40 },
  toWren: { ...type.caption, color: color.textSecondary, alignSelf: 'flex-end', marginTop: 8 },
  actions: { gap: 10 },
  note: { ...type.caption, color: color.textSecondary, textAlign: 'center' },
  signOut: { height: 48, alignItems: 'center', justifyContent: 'center' },
  signOutText: { fontFamily: font.uiSemiBold, fontSize: 15, color: color.ink, textDecorationLine: 'underline' },
});
