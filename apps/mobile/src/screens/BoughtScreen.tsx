// After a Buy. First buy only: "Show your people?" with Your people
// preselected (never Everyone by default). Then: "It's yours." and
// "Send it to someone?" — buying turns into a gift.

import React, { useState } from 'react';
import { Pressable, StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, layout, radius, spacing, type } from '../theme';
import { TopBar } from '../components/HeaderBack';
import { Button } from '../components/Button';
import { Icon } from '../components/Icon';
import { setPrivacy, Visibility } from '../api';
import { copy } from '../copy';
import { usdShort } from '../format';

type Props = {
  usd: number;
  stockName: string;
  askPrivacy: boolean;
  onHome: () => void;
  onSend: () => void;
};

export function PrivacyChoices({
  value,
  onChange,
  options,
  style,
}: {
  value: Visibility;
  onChange: (v: Visibility) => void;
  options: Visibility[];
  style?: StyleProp<ViewStyle>;
}) {
  const label = (v: Visibility) =>
    v === 'only_me' ? copy.visOnlyMe : v === 'your_people' ? copy.visYourPeople : copy.visEveryone;
  return (
    <View style={[styles.choices, style]}>
      {options.map((v) => {
        const on = v === value;
        return (
          <Pressable
            key={v}
            onPress={() => onChange(v)}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            style={[styles.choice, on && styles.choiceOn]}
          >
            <View style={styles.choiceText}>
              <Text style={styles.choiceLabel}>{label(v)}</Text>
              <Text style={styles.choiceNote}>{copy.visNote[v]}</Text>
            </View>
            <View style={[styles.radio, on && styles.radioOn]}>
              {on && <Icon name="check" size={14} color={color.textOnAction} strokeWidth={3} />}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

export function BoughtScreen({ usd, stockName, askPrivacy, onHome, onSend }: Props) {
  const [asking, setAsking] = useState(askPrivacy);
  const [choice, setChoice] = useState<Visibility>('your_people');
  const [saving, setSaving] = useState(false);

  if (asking) {
    return (
      <SafeAreaView style={styles.safe}>
        <TopBar />
        <View style={styles.body}>
          <Text style={styles.headline}>{copy.showPeopleTitle}</Text>
          <Text style={styles.sub}>{copy.showPeopleBody(stockName)}</Text>
          <PrivacyChoices value={choice} onChange={setChoice} options={['your_people', 'only_me']} />
          <Text style={[styles.sub, { marginTop: 16 }]}>{copy.showPeopleNote}</Text>
        </View>
        <View style={styles.footer}>
          <Button
            loading={saving}
            onPress={() => {
              setSaving(true);
              void setPrivacy(choice)
                .catch(() => undefined)
                .finally(() => {
                  setSaving(false);
                  setAsking(false);
                });
            }}
          >
            {copy.done}
          </Button>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <TopBar />
      <View style={styles.yours}>
        <Text style={styles.yoursTitle}>{copy.itsYours}</Text>
        <Text style={styles.yoursSub}>{copy.boughtWhat(usdShort(usd), stockName)}</Text>
      </View>
      <View style={styles.footer}>
        <Text style={styles.ask}>{copy.sendItToSomeone}</Text>
        <Button variant="ghost" onPress={onHome}>
          {copy.home}
        </Button>
        <Button onPress={onSend}>{copy.send}</Button>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.canvas },
  body: { paddingHorizontal: spacing.screenPad, paddingTop: layout.titleGap },
  headline: { ...type.headline, color: color.ink },
  sub: { ...type.bodyRegular, color: color.textSecondary, marginTop: 14 },
  choices: { marginTop: 28, gap: 10 },
  choice: {
    minHeight: 76,
    borderRadius: radius.card,
    backgroundColor: color.card,
    paddingHorizontal: 20,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  choiceOn: { backgroundColor: color.canvas, borderColor: color.ink },
  choiceText: { flex: 1, gap: 2 },
  choiceLabel: { ...type.body, color: color.ink },
  choiceNote: { ...type.caption, color: color.textSecondary },
  radio: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: color.hairline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOn: { backgroundColor: color.ink, borderColor: color.ink },
  yours: { flex: 1, alignItems: 'center', paddingTop: 96, paddingHorizontal: spacing.screenPad },
  yoursTitle: { ...type.nameLg, color: color.ink },
  yoursSub: { ...type.body, color: color.textSecondary, marginTop: 14, textAlign: 'center' },
  footer: {
    position: 'absolute',
    left: spacing.screenPad,
    right: spacing.screenPad,
    bottom: spacing.homeIndicator,
    gap: 8,
  },
  ask: { ...type.body, color: color.ink, textAlign: 'center', marginBottom: 8 },
});
