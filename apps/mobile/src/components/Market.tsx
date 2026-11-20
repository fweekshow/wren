// Market pieces: the green/red change chip, sparklines and the stock chart,
// the round letter badge for a company, and the pill switch used for
// Account | People, the chart ranges, and who sees your moves.

import React from 'react';
import { Pressable, StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import Svg, { Circle, Line, Path } from 'react-native-svg';
import { color, font, radius, type } from '../theme';

export function Change({ value, style }: { value: number | null | undefined; style?: StyleProp<ViewStyle> }) {
  if (value == null || !Number.isFinite(value)) return null;
  const up = value >= 0;
  return (
    <View style={[styles.change, { backgroundColor: up ? color.moveUp : color.moveDown }, style]}>
      <Text style={styles.changeText}>
        {up ? '+' : '−'}
        {Math.abs(value).toFixed(2)}%
      </Text>
    </View>
  );
}

function pathFor(values: number[], w: number, h: number, pad = 2): { d: string; end: { x: number; y: number }; y: (v: number) => number } {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const y = (v: number) => pad + (h - pad * 2) * (1 - (v - min) / span);
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  const pts = values.map((v, i) => ({ x: i * step, y: y(v) }));
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  return { d, end: pts[pts.length - 1] ?? { x: 0, y: h / 2 }, y };
}

export function Sparkline({
  values,
  width = 48,
  height = 24,
  strokeWidth = 1.5,
  dot = false,
}: {
  values: number[];
  width?: number;
  height?: number;
  strokeWidth?: number;
  dot?: boolean;
}) {
  if (values.length < 2) return <View style={{ width, height }} />;
  const { d, end } = pathFor(values, width, height, dot ? 8 : 2);
  return (
    <Svg width={width} height={height} style={{ overflow: 'visible' }}>
      <Path d={d} fill="none" stroke={color.ink} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" />
      {dot && (
        <>
          <Circle cx={end.x} cy={end.y} r={7} fill={color.card} />
          <Circle cx={end.x} cy={end.y} r={3.5} fill={color.ink} />
        </>
      )}
    </Svg>
  );
}

/** The stock page chart: a line, a dotted baseline at the opening price, a dot at now. */
export function Chart({ values, width, height = 180 }: { values: number[]; width: number; height?: number }) {
  if (values.length < 2) return <View style={{ width, height }} />;
  const { d, end, y } = pathFor(values, width, height, 10);
  const baseY = y(values[0]);
  return (
    <Svg width={width} height={height} style={{ overflow: 'visible' }}>
      <Line x1={0} x2={width} y1={baseY} y2={baseY} stroke={color.hairline} strokeWidth={1} strokeDasharray="2 4" />
      <Path d={d} fill="none" stroke={color.ink} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
      <Circle cx={end.x} cy={end.y} r={9} fill={color.card} />
      <Circle cx={end.x} cy={end.y} r={4.5} fill={color.ink} />
    </Svg>
  );
}

export function Letter({ name, size = 40, bg = color.canvas }: { name: string; size?: number; bg?: string }) {
  return (
    <View style={[styles.letter, { width: size, height: size, borderRadius: size / 2, backgroundColor: bg }]}>
      <Text style={{ fontFamily: font.uiSemiBold, fontSize: Math.round(size * 0.4), color: color.ink }}>
        {name.slice(0, 1).toUpperCase()}
      </Text>
    </View>
  );
}

type SegOption<T extends string> = { value: T; label: string };

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  fill = false,
  style,
}: {
  options: SegOption<T>[];
  value: T;
  onChange: (v: T) => void;
  fill?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.seg, style]}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            style={[styles.segBtn, fill && { flex: 1 }, on && styles.segOn]}
          >
            <Text style={styles.segText} numberOfLines={1}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Small gray pill button (Settings, Send on a row, Add cash). */
export function PillButton({
  children,
  onPress,
  dark = false,
  style,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  dark?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      hitSlop={6}
      style={({ pressed }) => [styles.pill, dark && styles.pillDark, pressed && { opacity: 0.7 }, style]}
    >
      <Text style={[styles.pillText, dark && { color: color.textOnAction }]}>{children}</Text>
    </Pressable>
  );
}

export function SectionLabel({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <View style={styles.sectionRow}>
      <Text style={styles.section}>{children}</Text>
      {right}
    </View>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export const rowLine = (i: number, n: number) =>
  i < n - 1 ? { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.hairline } : null;

const styles = StyleSheet.create({
  change: { height: 24, paddingHorizontal: 9, borderRadius: radius.pill, justifyContent: 'center', alignSelf: 'flex-start' },
  changeText: { ...type.percent, color: color.ink },
  letter: { alignItems: 'center', justifyContent: 'center' },
  seg: { flexDirection: 'row', gap: 4, padding: 4, borderRadius: radius.pill, backgroundColor: color.card },
  segBtn: { height: 32, paddingHorizontal: 14, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
  segOn: {
    backgroundColor: color.canvas,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
  segText: { fontFamily: font.uiSemiBold, fontSize: 15, lineHeight: 20, color: color.ink },
  pill: { height: 36, paddingHorizontal: 14, borderRadius: radius.pill, backgroundColor: color.card, justifyContent: 'center' },
  pillDark: { backgroundColor: color.ink },
  pillText: { fontFamily: font.uiSemiBold, fontSize: 15, color: color.ink },
  sectionRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  section: { ...type.label, color: color.textSecondary },
  card: { backgroundColor: color.card, borderRadius: radius.card, overflow: 'hidden' },
});
