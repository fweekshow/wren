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
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, font, layout, radius, spacing, type } from '../theme';
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
import { copy } from '../copy';
import { COUNTRIES, type Country } from '../countries';
import { CountryPickerScreen } from './CountryPickerScreen';
import { PinnedAction } from '../components/PinnedAction';
import { Icon } from '../components/Icon';

const UNITED_STATES = COUNTRIES.find((c) => c.code === 'US') ?? COUNTRIES[0];

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
  const [theirName, setTheirName] = useState('');
  const [theirNumber, setTheirNumber] = useState('');
  const [country, setCountry] = useState<Country>(UNITED_STATES);
  const [pickingCountry, setPickingCountry] = useState(false);

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
      } catch {
        if (!cancelled) setPeople([]);
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

  const typedPhone = toE164(theirNumber, country.dial);
  const canAdd = theirName.trim().length > 0 && !!typedPhone;

  const addSomeone = () => {
    if (!typedPhone) return;
    const first = theirName.trim();
    onPick({
      id: `typed-${typedPhone}`,
      firstName: first,
      lastName: '',
      phones: [{ raw: theirNumber, e164: typedPhone }],
      bestPhone: { raw: theirNumber, e164: typedPhone },
      firstLower: first.toLowerCase(),
      lastLower: '',
      hasE164: true,
    });
  };

  const recents = useMemo(() => {
    const byId = new Map(people.map((p) => [p.id, p] as const));
    return recentIds.map((id) => byId.get(id)).filter((p): p is Person => !!p);
  }, [people, recentIds]);

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

  const bookEmpty = perm === 'granted' && !loading && people.length === 0;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <HeaderBack onBack={onBack} />
      <View style={styles.title}>
        <Text style={styles.titleText}>Who’s it for?</Text>
      </View>

      {perm === 'granted' ? (
        <>
          {!bookEmpty && (
            <View style={styles.search}>
              <SearchField
                value={q}
                onChange={setQ}
                placeholder="Search people"
                autoFocus={false}
              />
            </View>
          )}
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
                bookEmpty ? (
                  <AddSomeone
                    name={theirName}
                    onName={setTheirName}
                    number={theirNumber}
                    onNumber={setTheirNumber}
                    dial={country.dial}
                    onDial={() => setPickingCountry(true)}
                  />
                ) : (
                  <Text style={styles.empty}>No match.</Text>
                )
              }
              renderSectionHeader={() => null}
            />
          )}
          {bookEmpty && (
            <PinnedAction>
              <Button disabled={!canAdd} onPress={addSomeone}>
                {copy.signInContinue}
              </Button>
            </PinnedAction>
          )}
        </>
      ) : (
        <>
          <Text style={styles.permCopy}>{copy.contactsBody}</Text>
          <Text style={styles.permTrust}>{copy.contactsTrust}</Text>
          <PinnedAction>
            <Button onPress={perm === 'denied' ? openSettings : ask}>
              {perm === 'denied' ? copy.contactsSettings : copy.contactsButton}
            </Button>
          </PinnedAction>
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.canvas },
  title: {
    paddingHorizontal: spacing.screenPad,
    paddingTop: layout.titleGap,
  },
  titleText: { ...type.headline, color: color.ink },
  search: { paddingHorizontal: spacing.screenPad, paddingTop: 24, paddingBottom: 8 },
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
  permTrust: {
    ...type.label,
    color: color.ink,
    marginTop: 20,
    paddingHorizontal: spacing.screenPad,
  },
  permCopy: {
    ...type.bodyRegular,
    color: color.textSecondary,
    marginTop: 14,
    paddingHorizontal: spacing.screenPad,
  },
  add: { paddingTop: 8 },
  hint: {
    ...type.bodyRegular,
    color: color.textSecondary,
    marginBottom: 20,
  },
  nameField: {
    height: 60,
    borderRadius: radius.pill,
    backgroundColor: color.card,
    paddingHorizontal: 22,
    fontFamily: font.ui,
    fontSize: 18,
    color: color.textPrimary,
  },
  phone: {
    height: 60,
    borderRadius: radius.pill,
    backgroundColor: color.card,
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
    paddingRight: 22,
  },
  dial: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 60,
    paddingLeft: 22,
    paddingRight: 10,
    gap: 2,
  },
  dialText: {
    fontFamily: font.ui,
    fontSize: 18,
    color: color.textPrimary,
  },
  chevron: { transform: [{ rotate: '-90deg' }] },
  rule: {
    width: StyleSheet.hairlineWidth,
    height: 22,
    backgroundColor: color.hairline,
    marginRight: 12,
  },
  number: {
    flex: 1,
    height: 60,
    fontFamily: font.ui,
    fontSize: 18,
    color: color.textPrimary,
  },
});

function AddSomeone({
  name,
  onName,
  number,
  onNumber,
  dial,
  onDial,
}: {
  name: string;
  onName: (v: string) => void;
  number: string;
  onNumber: (v: string) => void;
  dial: string;
  onDial: () => void;
}) {
  return (
    <View style={styles.add}>
      <Text style={styles.hint}>{copy.emptyPeople}</Text>
      <TextInput
        value={name}
        onChangeText={onName}
        placeholder={copy.theirName}
        placeholderTextColor={color.textTertiary}
        autoCapitalize="words"
        autoCorrect={false}
        style={styles.nameField}
      />
      <View style={styles.phone}>
        <Pressable onPress={onDial} style={styles.dial} accessibilityRole="button">
          <Text style={styles.dialText}>{dial}</Text>
          <Icon name="chevron-left" size={16} color={color.textSecondary} style={styles.chevron} />
        </Pressable>
        <View style={styles.rule} />
        <TextInput
          value={number}
          onChangeText={onNumber}
          placeholder="555 0100"
          placeholderTextColor={color.textTertiary}
          keyboardType="phone-pad"
          style={styles.number}
        />
      </View>
    </View>
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
