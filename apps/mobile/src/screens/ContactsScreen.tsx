// Sign-in step. Continue opens Apple's contacts sheet. Not now skips it.
// Granted contacts are loaded and sent up so Send can use them.

import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, spacing, type } from '../theme';
import { Wren } from '../components/Wren';
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
      <View style={styles.stage}>
        <View style={styles.halo}>
          <Wren size={128} />
        </View>
        <Text style={styles.title}>{copy.contactsTitle}</Text>
        <Text style={styles.body}>{copy.contactsBody}</Text>
      </View>
      <PinnedAction>
        <Button loading={busy} onPress={() => void onContinue()}>
          {copy.contactsButton}
        </Button>
        <Pressable onPress={onSkip} hitSlop={12} style={styles.skip}>
          <Text style={styles.skipText}>{copy.contactsSkip}</Text>
        </Pressable>
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
    paddingTop: 36,
  },
  halo: {
    width: 168,
    height: 168,
    borderRadius: 84,
    backgroundColor: color.wrenTint,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
  },
  title: {
    ...type.title,
    color: color.ink,
    marginTop: 28,
  },
  body: {
    ...type.bodyRegular,
    color: color.textSecondary,
    marginTop: 12,
  },
  skip: {
    alignItems: 'center',
    paddingTop: 16,
    paddingBottom: 4,
  },
  skipText: {
    ...type.label,
    color: color.textSecondary,
  },
});
