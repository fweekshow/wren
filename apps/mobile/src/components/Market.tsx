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

function pathFor(
  values: number[],
  w: number,
  h: number,
  pad = 2,
  padX = 0,
  scaleTo: number[] = values,
): { d: string; end: { x: number; y: number }; y: (v: number) => number } {
  const min = Math.min(...scaleTo);
  const max = Math.max(...scaleTo);
  const span = max - min || 1;
  const y = (v: number) => pad + (h - pad * 2) * (1 - (v - min) / span);
  const step = values.length > 1 ? (w - padX) / (values.length - 1) : 0;
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
  const { d, end } = pathFor(values, width, height, dot ? 8 : 2, dot ? 8 : 0);
  return (
    <Svg width={width} height={height} style={{ overflow: 'visible' }}>
      <Path d={d} fill="none" stroke={color.ink} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" />
      {dot && (
        <>
          <Circle cx={end.x} cy={end.y} r={7} fill={color.canvas} />
          <Circle cx={end.x} cy={end.y} r={3.5} fill={color.ink} />
        </>
      )}
    </Svg>
  );
}

/**
 * The stock page chart: a line, a dotted baseline at the opening price, a dot
 * at now. Touch and drag: a marker follows the finger, the line past it goes
 * gray, and `onScrub` reports the point (null on release) so the page can
 * show that price and time.
 */
export function Chart({
  values,
  width,
  height = 180,
  onScrub,
}: {
  values: number[];
  width: number;
  height?: number;
  onScrub?: (index: number | null) => void;
}) {
  const [at, setAt] = React.useState<number | null>(null);
  if (values.length < 2) return <View style={{ width, height }} />;
  const pad = 10;
  const { d, end, y } = pathFor(values, width, height, pad, pad);
  const baseY = y(values[0]);
  const step = (width - pad) / (values.length - 1);

  const pick = (x: number) => {
    const i = Math.max(0, Math.min(values.length - 1, Math.round(x / step)));
    if (i !== at) {
      setAt(i);
      onScrub?.(i);
    }
  };
  const release = () => {
    setAt(null);
    onScrub?.(null);
  };

  const px = at != null ? at * step : 0;
  const py = at != null ? y(values[at]) : 0;
  // While touching: ink up to the finger, gray after it.
  const upTo = at != null ? pathFor(values.slice(0, at + 1), at * step || 0.01, height, pad, 0, values) : null;

  return (
    <View
      style={{ width, height }}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(e) => pick(e.nativeEvent.locationX)}
      onResponderMove={(e) => pick(e.nativeEvent.locationX)}
      onResponderRelease={release}
      onResponderTerminate={release}
      accessibilityRole="adjustable"
      accessibilityLabel="Price chart. Touch and drag to see past prices."
    >
      <Svg width={width} height={height}>
        <Line x1={0} x2={width} y1={baseY} y2={baseY} stroke={color.hairline} strokeWidth={1} strokeDasharray="2 4" />
        {at == null ? (
          <>
            <Path d={d} fill="none" stroke={color.ink} strokeWidth={3.5} strokeLinejoin="round" strokeLinecap="round" />
            <Circle cx={end.x} cy={end.y} r={10} fill={color.canvas} />
            <Circle cx={end.x} cy={end.y} r={6} fill={color.ink} />
          </>
        ) : (
          <>
            <Path d={d} fill="none" stroke={color.hairline} strokeWidth={3.5} strokeLinejoin="round" strokeLinecap="round" />
            {upTo && (
              <Path d={upTo.d} fill="none" stroke={color.ink} strokeWidth={3.5} strokeLinejoin="round" strokeLinecap="round" />
            )}
            <Line x1={px} x2={px} y1={0} y2={height} stroke={color.ink} strokeWidth={1} />
            <Circle cx={px} cy={py} r={10} fill={color.canvas} />
            <Circle cx={px} cy={py} r={6} fill={color.ink} />
          </>
        )}
      </Svg>
    </View>
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

/**
 * Wren Bold stock tile (B7): name and ticker on top, the value big at the
 * bottom with today's change. `blue` is the one Wren Blue tile (your biggest
 * holding); the rest are Gray 10. `footer` replaces the change chip (Cash).
 */
export function StockTile({
  name,
  tickerText,
  value,
  change,
  blue = false,
  footer,
  width,
  onPress,
}: {
  name: string;
  tickerText: string;
  value: string;
  change?: number | null;
  blue?: boolean;
  footer?: string;
  width: number;
  onPress?: () => void;
}) {
  const ink = blue ? color.textOnAction : color.ink;
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={`${name}, ${value}`}
      style={({ pressed }) => [
        tileStyles.tile,
        { width, backgroundColor: blue ? color.wrenBody : color.card },
        pressed && tileStyles.pressed,
      ]}
    >
      <View style={tileStyles.top}>
        <Text style={[tileStyles.name, { color: ink }]} numberOfLines={1}>
          {name}
        </Text>
        <Text style={[tileStyles.ticker, { color: blue ? color.wrenTint : color.textSecondary }]}>{tickerText}</Text>
      </View>
      <View>
        <Text style={[type.tileValue, { color: ink }]} numberOfLines={1} adjustsFontSizeToFit>
          {value}
        </Text>
        <View style={tileStyles.foot}>
          {footer ? (
            <Text style={[type.caption, { color: blue ? color.wrenTint : color.textSecondary }]}>{footer}</Text>
          ) : (
            <Change value={change} />
          )}
        </View>
      </View>
    </Pressable>
  );
}

const tileStyles = StyleSheet.create({
  tile: { borderRadius: radius.tile, padding: 16, minHeight: 132, justifyContent: 'space-between' },
  pressed: { transform: [{ scale: 0.97 }] },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  name: { fontFamily: font.uiSemiBold, fontSize: 16, lineHeight: 18, flexShrink: 1 },
  ticker: { ...type.ticker },
  foot: { marginTop: 8, minHeight: 24, justifyContent: 'center', alignItems: 'flex-start' },
});
