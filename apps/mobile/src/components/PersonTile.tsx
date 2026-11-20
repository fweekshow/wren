// Face + name tile used in the "recent faces" row at the top of Someone.
// No "Has Wren" dot — that's intentionally dropped per product spec.

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { color, type } from '../theme';
import { Avatar } from './Avatar';

type Props = {
  name: string;
  selected?: boolean;
  size?: number;
  onPress?: () => void;
};

export function PersonTile({ name, selected = false, size = 64, onPress }: Props) {
  return (
    <Pressable onPress={onPress} style={styles.tile} hitSlop={6}>
      <Avatar name={name} size={size} selected={selected} />
      <Text style={styles.name} numberOfLines={1}>
        {name}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: {
    alignItems: 'center',
    width: 92,
    paddingVertical: 4,
  },
  name: {
    ...type.body,
    color: color.textPrimary,
    marginTop: 6,
  },
});

// A row of person tiles that scrolls horizontally (for the recent faces strip).
type RowProps = {
  people: { id: string; firstName: string }[];
  selectedId?: string;
  onPick: (id: string) => void;
};

export function PersonRow({ people, selectedId, onPick }: RowProps) {
  if (!people.length) return <View style={{ height: 0 }} />;
  return (
    <View style={rowStyles.row}>
      {people.map((p) => (
        <PersonTile
          key={p.id}
          name={p.firstName}
          selected={p.id === selectedId}
          onPress={() => onPick(p.id)}
        />
      ))}
    </View>
  );
}

const rowStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    paddingHorizontal: 24,
  },
});
