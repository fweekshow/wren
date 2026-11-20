// Settings: who sees your moves, where you get messages, cash, what it costs.

import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, layout, spacing, type } from '../theme';
import { HeaderBack } from '../components/HeaderBack';
import { Card, PillButton, rowLine, SectionLabel } from '../components/Market';
import { PrivacyChoices } from './BoughtScreen';
import { ConnectState, getConnectState, getPrivacy, setPrivacy, Visibility } from '../api';
import { copy } from '../copy';

type Props = {
  onBack: () => void;
  onConnect: () => void;
  onAddCash: () => void;
  onSignOut: () => void;
};

export function SettingsScreen({ onBack, onConnect, onAddCash, onSignOut }: Props) {
  const [visibility, setVis] = useState<Visibility | null>(null);
  const [connect, setConnect] = useState<ConnectState | null>(null);

  useEffect(() => {
    getPrivacy()
      .then((p) => setVis(p.visibility))
      .catch(() => setVis('only_me'));
    getConnectState()
      .then(setConnect)
      .catch(() => undefined);
  }, []);

  const pick = (v: Visibility) => {
    const prev = visibility;
    setVis(v);
    void setPrivacy(v).catch(() => setVis(prev));
  };

  const channels = [
    { label: copy.iMessage, on: !!connect?.imessageOptedInAt },
    { label: copy.whatsapp, on: !!connect?.whatsappOptedInAt },
  ];

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <HeaderBack onBack={onBack} />
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>{copy.settings}</Text>

        <View style={styles.section}>
          <SectionLabel>{copy.whoSees}</SectionLabel>
          {visibility && (
            <PrivacyChoices value={visibility} onChange={pick} options={['only_me', 'your_people', 'everyone']} />
          )}
        </View>

        <View style={styles.section}>
          <SectionLabel>{copy.messagesOn}</SectionLabel>
          <Card style={{ marginTop: 12 }}>
            {channels.map((c, i) => (
              <View key={c.label} style={[styles.row, rowLine(i, channels.length)]}>
                <Text style={[styles.body, { flex: 1 }]}>{c.label}</Text>
                {c.on ? (
                  <Text style={styles.on}>{copy.channelOn}</Text>
                ) : (
                  <PillButton onPress={onConnect} style={{ backgroundColor: color.canvas }}>
                    {copy.channelConnect}
                  </PillButton>
                )}
              </View>
            ))}
          </Card>
        </View>

        <View style={styles.section}>
          <SectionLabel>{copy.cashSection}</SectionLabel>
          <Card style={{ marginTop: 12 }}>
            <Pressable onPress={onAddCash} style={styles.row}>
              <Text style={styles.body}>{copy.addCash}</Text>
            </Pressable>
          </Card>
        </View>

        <View style={styles.section}>
          <SectionLabel>{copy.whatItCosts}</SectionLabel>
          <Card style={{ marginTop: 12, paddingVertical: 8 }}>
            {copy.costLines.map((l) => (
              <Text key={l} style={styles.cost}>
                {l}
              </Text>
            ))}
          </Card>
        </View>

        <Pressable onPress={onSignOut} style={styles.signOut} hitSlop={8}>
          <Text style={styles.signOutText}>{copy.signOut}</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.canvas },
  scroll: { paddingHorizontal: spacing.screenPad, paddingTop: layout.titleGap, paddingBottom: 60 },
  title: { ...type.title, color: color.ink },
  section: { marginTop: 32 },
  row: { minHeight: 64, paddingLeft: 20, paddingRight: 12, flexDirection: 'row', alignItems: 'center', gap: 12 },
  body: { ...type.body, color: color.ink },
  on: { ...type.label, color: color.textSecondary, paddingRight: 8 },
  cost: { ...type.body, color: color.ink, paddingHorizontal: 20, paddingVertical: 8 },
  signOut: { marginTop: 40, alignSelf: 'center' },
  signOutText: { ...type.label, color: color.textSecondary },
});
