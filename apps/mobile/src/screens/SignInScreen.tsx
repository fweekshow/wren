// Sign in. Two paths, picked by the country on "Your number":
// - US and Canada: Privy phone login (texted code).
// - Everywhere else: Privy email login. Their number is confirmed later,
//   in Connect, by the text they send Wren (see ConnectScreen verify mode).

import React, { useState } from 'react';
import {
  Image,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLoginWithEmail, useLoginWithSMS } from '@privy-io/expo';
import { color, font, layout, radius, spacing, type } from '../theme';
import { Button } from '../components/Button';
import { HeaderBack, TopBar } from '../components/HeaderBack';
import { PinnedAction } from '../components/PinnedAction';
import { copy } from '../copy';
import { apiHost } from '../api';
import { COUNTRIES, usesPhoneLogin, type Country } from '../countries';
import { CountryPickerScreen } from './CountryPickerScreen';

// The chat-bird logo, in Welcome's top bar: the first thing people see.
const LOGO = require('../../assets/logo.png');

const UNITED_STATES = COUNTRIES.find((c) => c.code === 'US') ?? COUNTRIES[0];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

type Phase = 'welcome' | 'phone' | 'code' | 'email' | 'emailCode';

export function SignInScreen() {
  const [phase, setPhase] = useState<Phase>('welcome');
  const [country, setCountry] = useState<Country>(UNITED_STATES);
  const [pickingCountry, setPickingCountry] = useState(false);
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [codeDigits, setCodeDigits] = useState('');
  const [error, setError] = useState<string | null>(null);

  const sms = useLoginWithSMS({
    onError: (err) => setError(toCopy(err)),
    onSendCodeSuccess: () => {
      setError(null);
      setCodeDigits('');
      setPhase('code');
    },
  });
  const mail = useLoginWithEmail({
    onError: (err) => setError(toCopy(err)),
    onSendCodeSuccess: () => {
      setError(null);
      setCodeDigits('');
      setPhase('emailCode');
    },
  });

  const busy =
    sms.state.status === 'sending-code' ||
    sms.state.status === 'submitting-code' ||
    mail.state.status === 'sending-code' ||
    mail.state.status === 'submitting-code';
  const phoneLogin = usesPhoneLogin(country);
  const e164 = toE164(phone, country.dial);
  const codeOk = /^\d{6}$/.test(codeDigits);
  const emailOk = EMAIL_RE.test(email.trim());
  const origin = apiHost();

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(toCopy(err));
    }
  };

  const onContinue = () => {
    switch (phase) {
      case 'welcome':
        setPhase('phone');
        return;
      case 'phone':
        if (!e164) return;
        if (phoneLogin) void run(() => sms.sendCode({ phone: e164 }));
        else setPhase('email');
        return;
      case 'code':
        if (e164 && codeOk) void run(() => sms.loginWithCode({ code: codeDigits, phone: e164 }));
        return;
      case 'email':
        if (emailOk) void run(() => mail.sendCode({ email: email.trim() }));
        return;
      case 'emailCode':
        if (codeOk) void run(() => mail.loginWithCode({ code: codeDigits, email: email.trim() }));
        return;
    }
  };

  const back = () => {
    setError(null);
    if (phase === 'phone') setPhase('welcome');
    else if (phase === 'code' || phase === 'email') setPhase('phone');
    else if (phase === 'emailCode') setPhase('email');
  };

  const sendAgain = () => {
    setCodeDigits('');
    if (phase === 'code' && e164) void run(() => sms.sendCode({ phone: e164 }));
    if (phase === 'emailCode') void run(() => mail.sendCode({ email: email.trim() }));
  };

  if (pickingCountry) {
    return (
      <CountryPickerScreen
        onBack={() => setPickingCountry(false)}
        onPick={(next) => {
          setCountry(next);
          setPickingCountry(false);
        }}
      />
    );
  }

  const canContinue =
    !busy &&
    (phase === 'welcome' ||
      (phase === 'phone' && !!e164) ||
      ((phase === 'code' || phase === 'emailCode') && codeOk) ||
      (phase === 'email' && emailOk));
  const label =
    phase === 'welcome'
      ? copy.welcomeButton
      : phase === 'code' || phase === 'emailCode'
        ? busy
          ? copy.signInBusy
          : copy.signInButton
        : busy
          ? copy.signInSending
          : copy.signInContinue;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <KeyboardAvoidingView style={styles.fill} behavior={undefined}>
        {phase === 'welcome' ? (
          <>
            <TopBar>
              <Image source={LOGO} style={styles.logo} resizeMode="contain" accessibilityLabel="Wren" />
            </TopBar>
            <View style={styles.body}>
              <Text style={styles.welcomeTitle}>{copy.welcomeTitle}</Text>
              <Text style={styles.sub}>{copy.welcomeBody}</Text>
              <Text style={[styles.sub, { marginTop: 6 }]}>{copy.welcomeChats}</Text>
            </View>
          </>
        ) : (
          <>
            <HeaderBack onBack={back} />
            <View style={styles.body}>
              {phase === 'phone' && (
                <>
                  <Text style={styles.headline}>{copy.signInTitle}</Text>
                  <View style={styles.phoneRow}>
                    <Pressable
                      onPress={() => setPickingCountry(true)}
                      style={styles.country}
                      accessibilityRole="button"
                      accessibilityLabel={`${country.name}, ${country.dial}`}
                    >
                      <Text style={styles.countryCode}>{country.code}</Text>
                      <Text style={styles.countryDial}>{country.dial}</Text>
                    </Pressable>
                    <TextInput
                      value={phone}
                      onChangeText={setPhone}
                      keyboardType="phone-pad"
                      autoComplete="tel"
                      textContentType="telephoneNumber"
                      placeholder="Number"
                      placeholderTextColor={color.textTertiary}
                      accessibilityLabel={copy.signInTitle}
                      autoFocus
                      style={styles.bigInput}
                    />
                  </View>
                  <View style={styles.rule} />
                  <Text style={styles.note}>{phoneLogin ? copy.phoneNoteText : copy.phoneNoteEmail}</Text>
                </>
              )}
              {phase === 'email' && (
                <>
                  <Text style={styles.headline}>{copy.emailTitle}</Text>
                  <Text style={styles.sub}>{copy.emailBody}</Text>
                  <TextInput
                    value={email}
                    onChangeText={setEmail}
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="email"
                    textContentType="emailAddress"
                    placeholder="you@example.com"
                    placeholderTextColor={color.textTertiary}
                    accessibilityLabel={copy.emailTitle}
                    autoFocus
                    style={[styles.bigInput, styles.emailInput]}
                  />
                  <View style={styles.rule} />
                  <Text style={styles.note}>{copy.emailNote}</Text>
                </>
              )}
              {(phase === 'code' || phase === 'emailCode') && (
                <>
                  <Text style={styles.headline}>{phase === 'code' ? copy.codeTitle : copy.emailCodeTitle}</Text>
                  <Text style={styles.sub}>
                    {copy.sentTo} {phase === 'code' ? formatPhone(phone, country) : email.trim()}.
                  </Text>
                  <TextInput
                    value={codeDigits}
                    onChangeText={(v) => setCodeDigits(v.replace(/\D/g, '').slice(0, 6))}
                    keyboardType="number-pad"
                    autoComplete="one-time-code"
                    textContentType="oneTimeCode"
                    placeholder="000000"
                    placeholderTextColor={color.textTertiary}
                    accessibilityLabel={phase === 'code' ? copy.codeTitle : copy.emailCodeTitle}
                    autoFocus
                    style={styles.codeInput}
                  />
                  <Pressable onPress={sendAgain} accessibilityRole="button" style={styles.linkBtn}>
                    <Text style={styles.link}>{copy.sendAgain}</Text>
                  </Pressable>
                </>
              )}
              {error ? <Text style={styles.error}>{error}</Text> : null}
            </View>
          </>
        )}
        <PinnedAction>
          <View style={styles.actions}>
            <Button disabled={!canContinue} loading={busy} onPress={onContinue}>
              {label}
            </Button>
            {phase === 'welcome' ? (
              <Text style={styles.consent}>
                {copy.signInConsent}{' '}
                {origin ? (
                  <>
                    <Text style={styles.inlineLink} onPress={() => void Linking.openURL(`${origin}/terms`)}>
                      {copy.terms}
                    </Text>
                    {' and '}
                    <Text style={styles.inlineLink} onPress={() => void Linking.openURL(`${origin}/privacy`)}>
                      {copy.privacy}
                    </Text>
                    {'.'}
                  </>
                ) : (
                  `${copy.terms} and ${copy.privacy}.`
                )}
              </Text>
            ) : null}
          </View>
        </PinnedAction>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function toE164(national: string, dial: string): string | null {
  const dialDigits = dial.replace(/\D/g, '');
  let digits = national.replace(/\D/g, '');
  if (!dialDigits || !digits) return null;
  if (digits.startsWith(dialDigits) && digits.length > dialDigits.length + 5) {
    digits = digits.slice(dialDigits.length);
  }
  if (dialDigits === '1' && digits.length === 11 && digits.startsWith('1')) {
    digits = digits.slice(1);
  }
  if (dialDigits === '1' && digits.length !== 10) return null;
  const e164 = `+${dialDigits}${digits}`;
  return /^\+\d{8,15}$/.test(e164) ? e164 : null;
}

function formatPhone(national: string, country: Country): string {
  const d = national.replace(/\D/g, '');
  if (country.dial === '+1' && d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return `${country.dial} ${d}`;
}

function toCopy(err: unknown): string {
  return err instanceof Error ? err.message : copy.didntGo;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.canvas },
  fill: { flex: 1 },
  logo: { width: 40, height: 40 },
  welcomeTitle: { ...type.headlineXl, color: color.ink },
  body: { paddingHorizontal: spacing.screenPad, paddingTop: layout.titleGap },
  headline: { ...type.headline, color: color.ink },
  sub: { ...type.bodyRegular, color: color.textSecondary, marginTop: 14 },
  phoneRow: { marginTop: 28, height: 56, flexDirection: 'row', alignItems: 'center', gap: 12 },
  country: {
    height: 40,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    backgroundColor: color.card,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  countryCode: { ...type.ticker, color: color.ink },
  countryDial: { fontFamily: font.uiSemiBold, fontSize: 15, color: color.ink },
  bigInput: {
    flex: 1,
    height: 56,
    fontFamily: font.display,
    fontSize: 32,
    letterSpacing: -0.6,
    color: color.ink,
  },
  emailInput: { flex: 0, marginTop: 24, fontSize: 28 },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: color.hairline },
  note: { ...type.caption, color: color.textSecondary, marginTop: 12 },
  codeInput: {
    marginTop: 32,
    height: 64,
    borderRadius: 16,
    backgroundColor: color.card,
    paddingHorizontal: 22,
    fontFamily: font.display,
    fontSize: 30,
    letterSpacing: 8,
    color: color.ink,
  },
  linkBtn: { marginTop: 20, alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center' },
  link: { fontFamily: font.uiSemiBold, fontSize: 15, color: color.ink, textDecorationLine: 'underline' },
  error: { ...type.body, color: color.ink, marginTop: 16 },
  actions: { gap: 14 },
  consent: { ...type.caption, color: color.textSecondary, textAlign: 'center' },
  inlineLink: { color: color.ink },
});
