// Sign-in step. Continue opens Apple's contacts sheet. Not now skips it.
// One headline, one line, one blue pill. No illustration.
// Granted contacts are loaded and sent up so Send can use them.

import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, layout, spacing, type } from '../theme';
import { TopBar } from '../components/HeaderBack';
import { Button } from '../components/Button';
import { PinnedAction } from '../components/PinnedAction';
import { copy } from '../copy';
import { loadContacts, requestContactsPermission } from '../contacts';
import { getSession } from '../auth';
import { importContacts } from '../api';

type Props = {
  onDone: () => void;
  onSkip: () => void;
};

export function ContactsScreen({ onDone, onSkip }: Props) {
  const [busy, setBusy] = useState(false);

  const onContinue = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await requestContactsPermission();
      if (res.granted) {
        const people = await loadContacts();
        const uploads = people
          .flatMap((p) => p.phones.map((ph) => ({ name: p.firstName, phone: ph.e164 ?? '' })))
          .filter((u) => !!u.phone);
        if (uploads.length) void uploadWhenSignedIn(uploads);
      }
    } finally {
      setBusy(false);
      onDone();
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <TopBar />
      <View style={styles.stage}>
        <Text style={styles.title}>{copy.contactsTitle}</Text>
        <Text style={styles.body}>{copy.contactsBody}</Text>
        <Text style={styles.trust}>{copy.contactsTrust}</Text>
      </View>
      <PinnedAction>
        <Button loading={busy} onPress={() => void onContinue()}>
          {copy.contactsButton}
        </Button>
        <View style={styles.gap} />
        <Button variant="ghost" onPress={onSkip}>
          {copy.contactsSkip}
        </Button>
      </PinnedAction>
    </SafeAreaView>
  );
}

async function uploadWhenSignedIn(
  uploads: { name: string; phone: string }[],
): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const session = await getSession();
    if (session) {
      try {
        await importContacts(uploads);
      } catch {
        // Send still reads the phone's own contacts.
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.canvas },
  stage: {
    flex: 1,
    paddingHorizontal: spacing.screenPad,
    paddingTop: layout.titleGap,
  },
  title: { ...type.headline, color: color.ink },
  body: {
    ...type.bodyRegular,
    color: color.textSecondary,
    marginTop: 14,
  },
  trust: { ...type.label, color: color.ink, marginTop: 20 },
  gap: { height: 10 },
});
