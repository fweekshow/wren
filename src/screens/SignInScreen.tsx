// Sign in — native, via Privy. Email + one-time code, no web handoff.
// Two phases in one screen: "email" and "code". We render the bird large,
// then one field (a pill), then the pinned pill. Any rendered error lives on
// a single quiet line above the button — no alerts, no banners.

import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLoginWithEmail } from '@privy-io/expo';
import { color, font, radius, spacing, type } from '../theme';
import { Button } from '../components/Button';
import { Wren } from '../components/Wren';
import { PinnedAction } from '../components/PinnedAction';

type Phase = 'email' | 'code';

export function SignInScreen() {
  const [phase, setPhase] = useState<Phase>('email');
  const [email, setEmail] = useState('');
  const [codeDigits, setCodeDigits] = useState('');
  const [error, setError] = useState<string | null>(null);

  // `onLoginSuccess` is picked up by App.tsx via usePrivy() — no need to
  // route anything from here; the moment Privy flips to authenticated the
  // app re-renders Home.
  const { sendCode, loginWithCode, state } = useLoginWithEmail({
    onError: (err) => {
      setError(toCopy(err));
    },
    onSendCodeSuccess: () => {
      setError(null);
      setPhase('code');
    },
  });

  const sending = state.status === 'sending-code';
  const submitting = state.status === 'submitting-code';
  const busy = sending || submitting;

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const codeOk = /^\d{6}$/.test(codeDigits);

  const onPrimary = async () => {
    setError(null);
    try {
      if (phase === 'email') {
        if (!emailOk) return;
        await sendCode({ email: email.trim() });
      } else {
        if (!codeOk) return;
        await loginWithCode({ code: codeDigits, email: email.trim() });
      }
    } catch (err) {
      setError(toCopy(err));
    }
  };

  const label =
    phase === 'email'
      ? sending
        ? 'Sending'
        : 'Continue'
      : submitting
        ? 'Signing in'
        : 'Sign in';

  const canContinue =
    phase === 'email' ? emailOk && !busy : codeOk && !busy;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.hero}>
          <Wren size={150} />
          <Text style={styles.title}>Wren</Text>
          <Text style={styles.sub}>
            Pick someone you know and send them a stock.
          </Text>
        </View>

        <View style={styles.formWrap}>
          {phase === 'email' ? (
            <View style={styles.field}>
              <TextInput
                value={email}
                onChangeText={(t) => {
                  setEmail(t);
                  if (error) setError(null);
                }}
                placeholder="you@email.com"
                placeholderTextColor={color.textTertiary}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                keyboardType="email-address"
                returnKeyType="next"
                onSubmitEditing={onPrimary}
                style={styles.input}
              />
            </View>
          ) : (
            <View style={styles.field}>
              <TextInput
                value={codeDigits}
                onChangeText={(t) => {
                  const digits = t.replace(/\D/g, '').slice(0, 6);
                  setCodeDigits(digits);
                  if (error) setError(null);
                }}
                placeholder="6-digit code"
                placeholderTextColor={color.textTertiary}
                keyboardType="number-pad"
                autoComplete="one-time-code"
                textContentType="oneTimeCode"
                returnKeyType="done"
                autoFocus
                onSubmitEditing={onPrimary}
                style={[styles.input, styles.inputCode]}
              />
            </View>
          )}
          {phase === 'code' && (
            <Pressable
              onPress={() => {
                setPhase('email');
                setCodeDigits('');
                setError(null);
              }}
              style={styles.changeEmail}
              hitSlop={8}
            >
              <Text style={styles.changeEmailText}>Use a different email</Text>
            </Pressable>
          )}
        </View>

        <PinnedAction>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Button
            onPress={onPrimary}
            disabled={!canContinue}
            loading={busy}
          >
            {label}
          </Button>
        </PinnedAction>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// Keep error copy short, human, and plain — no vocabulary from the ban-list.
function toCopy(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  const lower = msg.toLowerCase();
  if (lower.includes('network') || lower.includes('fetch')) return "Can't reach the internet.";
  if (lower.includes('invalid') && lower.includes('code')) return 'That code did not match.';
  if (lower.includes('expired')) return 'That code expired. Try again.';
  if (lower.includes('rate') || lower.includes('too many')) return 'Too many tries. Give it a minute.';
  return "That didn't go through.";
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.canvas },
  hero: {
    alignItems: 'center',
    paddingTop: 72,
    paddingHorizontal: spacing.screenPad,
    gap: 14,
  },
  title: { ...type.nameLg, color: color.textPrimary, marginTop: 8 },
  sub: {
    ...type.bodyRegular,
    color: color.textSecondary,
    textAlign: 'center',
  },
  formWrap: {
    marginTop: 48,
    paddingHorizontal: spacing.screenPad,
    gap: 12,
  },
  field: {
    height: 56,
    backgroundColor: color.card,
    borderRadius: radius.pill,
    paddingHorizontal: 22,
    justifyContent: 'center',
  },
  input: {
    ...type.body,
    color: color.textPrimary,
    padding: 0,
  },
  inputCode: {
    fontFamily: font.mono,
    fontSize: 20,
    letterSpacing: 6,
    textAlign: 'center',
  },
  changeEmail: {
    alignSelf: 'center',
    paddingVertical: 8,
  },
  changeEmailText: {
    ...type.caption,
    color: color.textSecondary,
  },
  error: {
    ...type.caption,
    color: color.moveDown,
    textAlign: 'center',
    marginBottom: 10,
  },
});
