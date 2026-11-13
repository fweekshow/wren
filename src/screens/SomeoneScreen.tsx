// Someone: "Who's it for?"
// - expo-contacts, denied → short copy + Settings button
// - search matches first and last name
// - one row of recent faces, then the book as alphabetical rows
// - last name in gray when two people share a first name
// - email-only contacts hidden; non-E.164 phones block Amount
// - on first allow, we kick off a chunked import to /api/app/contacts/import

import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, spacing, type } from '../theme';
import { Wren } from '../components/Wren';
import { SearchField } from '../components/SearchField';
import { PersonTile } from '../components/PersonTile';
import { Avatar } from '../components/Avatar';
import { HeaderBack } from '../components/HeaderBack';
import { Button } from '../components/Button';
import {
  duplicatedFirstNames,
  getContactsPermission,
  loadContacts,
  Person,
  requestContactsPermission,
  searchPeople,
} from '../contacts';
import { importContacts } from '../api';

type Props = {
  onBack: () => void;
  onPick: (p: Person) => void;
  recentIds: string[];
};

type PermState = 'unknown' | 'ask' | 'denied' | 'granted';

export function SomeoneScreen({ onBack, onPick, recentIds }: Props) {
  const [perm, setPerm] = useState<PermState>('unknown');
  const [people, setPeople] = useState<Person[]>([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const current = await getContactsPermission();
      if (cancelled) return;
      if (current.granted) {
        setPerm('granted');
      } else if (current.canAskAgain) {
        setPerm('ask');
      } else {
        setPerm('denied');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (perm !== 'granted') return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const list = await loadContacts();
        if (!cancelled) setPeople(list);
        // Fire-and-forget the import — only +/7-15-digit phones go up.
        void (async () => {
          const uploads = list
            .flatMap((p) => p.phones.map((ph) => ({ name: p.firstName, phone: ph.e164 ?? '' })))
            .filter((u) => !!u.phone);
          if (uploads.length) {
            try {
              await importContacts(uploads);
            } catch {
              // Non-fatal.
            }
          }
        })();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [perm]);

  const ask = async () => {
    const res = await requestContactsPermission();
    if (res.granted) setPerm('granted');
    else setPerm(res.canAskAgain ? 'ask' : 'denied');
  };

  const openSettings = () => {
    void Linking.openSettings();
  };

  const filtered = useMemo(() => searchPeople(people, q), [people, q]);
  const dupFirst = useMemo(() => duplicatedFirstNames(filtered), [filtered]);

  const recents = useMemo(() => {
    const byId = new Map(people.map((p) => [p.id, p] as const));
    return recentIds.map((id) => byId.get(id)).filter((p): p is Person => !!p);
  }, [people, recentIds]);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <HeaderBack onBack={onBack} />
      <View style={styles.title}>
        <Wren size={84} />
        <Text style={styles.titleText}>Who's it for?</Text>
      </View>

      {perm === 'granted' ? (
        <>
          <View style={styles.search}>
            <SearchField
              value={q}
              onChange={setQ}
              placeholder="Search people"
              autoFocus={false}
            />
          </View>
          {recents.length > 0 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.recentsRow}
            >
              {recents.map((p) => (
                <PersonTile
                  key={p.id}
                  name={p.firstName}
                  onPress={() => onPick(p)}
                />
              ))}
            </ScrollView>
          )}
          {loading && !people.length ? (
            <View style={styles.center}>
              <ActivityIndicator color={color.textTertiary} />
            </View>
          ) : (
            <SectionList
              sections={[{ title: 'all', data: filtered }]}
              keyExtractor={(p) => p.id}
              contentContainerStyle={styles.listPad}
              renderItem={({ item, index, section }) => {
                const last = index === section.data.length - 1;
                const showLast = dupFirst.has(item.firstLower) && item.lastName;
                return (
                  <Pressable style={styles.row} onPress={() => onPick(item)}>
                    <Avatar name={item.firstName} size={44} />
                    <View style={styles.rowText}>
                      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
                        <Text style={styles.name} numberOfLines={1}>
                          {item.firstName}
                        </Text>
                        {showLast && (
                          <Text style={styles.last} numberOfLines={1}>
                            {item.lastName}
                          </Text>
                        )}
                      </View>
                    </View>
                    {!last && <View style={styles.hairline} />}
                  </Pressable>
                );
              }}
              ListEmptyComponent={
                <Text style={styles.empty}>No match.</Text>
              }
              renderSectionHeader={() => null}
            />
          )}
        </>
      ) : (
        <View style={styles.permWrap}>
          <Text style={styles.permCopy}>Allow contacts to choose someone.</Text>
          <View style={{ height: 24 }} />
          <View style={{ alignSelf: 'stretch' }}>
            <Button
              variant="primary"
              onPress={perm === 'denied' ? openSettings : ask}
            >
              Settings
            </Button>
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.canvas },
  title: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 24,
    paddingTop: 4,
  },
  titleText: { ...type.title, color: color.textPrimary },
  search: { paddingHorizontal: 24, paddingTop: 20, paddingBottom: 8 },
  recentsRow: { paddingHorizontal: 24, paddingVertical: 8, gap: 0 },
  listPad: { paddingHorizontal: spacing.screenPad, paddingTop: 8, paddingBottom: 40 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 12,
    paddingHorizontal: 8,
  },
  rowText: { flex: 1, minWidth: 0 },
  name: { ...type.body, color: color.textPrimary },
  last: { ...type.bodyRegular, color: color.textTertiary },
  hairline: {
    position: 'absolute',
    left: 66,
    right: 8,
    bottom: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.hairline,
  },
  empty: {
    ...type.bodyRegular,
    color: color.textSecondary,
    textAlign: 'center',
    paddingTop: 40,
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  permWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  permCopy: {
    ...type.body,
    color: color.textPrimary,
    textAlign: 'center',
  },
});
