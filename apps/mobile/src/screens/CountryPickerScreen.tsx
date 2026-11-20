// Phone-region sheet. Opens when a chosen contact's number lacks a leading +.
// We don't guess +1; the user picks.

import React, { useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, type } from '../theme';
import { HeaderBack } from '../components/HeaderBack';
import { SearchField } from '../components/SearchField';
import { COUNTRIES, Country, countriesByQuery } from '../countries';

type Props = {
  onBack: () => void;
  onPick: (c: Country) => void;
};

export function CountryPickerScreen({ onBack, onPick }: Props) {
  const [q, setQ] = useState('');
  const list = useMemo(() => countriesByQuery(q), [q]);
  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <HeaderBack onBack={onBack} title="Which country?" />
      <View style={styles.search}>
        <SearchField value={q} onChange={setQ} placeholder="Search countries" />
      </View>
      <FlatList<Country>
        data={list}
        keyExtractor={(c) => c.code}
        initialNumToRender={20}
        contentContainerStyle={styles.listPad}
        renderItem={({ item, index }) => (
          <Pressable style={styles.row} onPress={() => onPick(item)}>
            <Text style={styles.name}>{item.name}</Text>
            <Text style={styles.dial}>{item.dial}</Text>
            {index !== list.length - 1 && <View style={styles.hairline} />}
          </Pressable>
        )}
        ListEmptyComponent={
          <Text style={styles.empty}>No match. Try the country name or dial code.</Text>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.canvas },
  search: { paddingHorizontal: 24, paddingTop: 4, paddingBottom: 12 },
  listPad: { paddingHorizontal: 24, paddingBottom: 60 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 56,
    paddingHorizontal: 16,
  },
  name: { ...type.body, color: color.textPrimary, flex: 1 },
  dial: { ...type.price, color: color.textSecondary },
  hairline: {
    position: 'absolute',
    left: 16,
    right: 16,
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
});

export { COUNTRIES };
