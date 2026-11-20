// Market pieces: the green/red change chip, sparklines and the stock chart,
// the round letter badge for a company, and the pill switch used for
// Account | People, the chart ranges, and who sees your moves.

import React from 'react';
import { Pressable, StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import Svg, { Circle, Line, Path } from 'react-native-svg';
import { color, font, radius, StockColor, stockColor, type } from '../theme';

/** Up/down arrow: a filled triangle. */
export function Arrow({ up, size = 12, fill }: { up: boolean; size?: number; fill: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 14 14">
      <Path d={up ? 'M7 2 L12 9 H2 Z' : 'M7 12 L2 5 H12 Z'} fill={fill} />
    </Svg>
  );
}

/**
 * A move (Wren Color): an arrow and the percent. On white it's a chip, lime
 * up or coral down, ink text. `on` = the text color of a colored card it sits
 * on: then no chip, just arrow and percent in that color.
 */
export function Change({
  value,
  on,
  style,
}: {
  value: number | null | undefined;
  on?: string;
  style?: StyleProp<ViewStyle>;
}) {
  if (value == null || !Number.isFinite(value)) return null;
  const up = value >= 0;
  const pct = `${Math.abs(value).toFixed(2)}%`;
  const label = `${up ? 'Up' : 'Down'} ${pct}`;
  if (on) {
    return (
      <View style={[styles.changeBare, style]} accessibilityLabel={label}>
        <Arrow up={up} fill={on} />
        <Text style={[styles.changeText, { color: on }]}>{pct}</Text>
      </View>
    );
  }
  return (
    <View
      style={[styles.change, { backgroundColor: up ? color.moveUp : color.moveDown }, style]}
      accessibilityLabel={label}
    >
      <Arrow up={up} fill={color.ink} />
      <Text style={styles.changeText}>{pct}</Text>
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
  ink = color.ink,
  faded = color.hairline,
  ground = color.canvas,
}: {
  values: number[];
  width: number;
  height?: number;
  onScrub?: (index: number | null) => void;
  /** Line color; `faded` = the line past your finger; `ground` = what it sits on. */
  ink?: string;
  faded?: string;
  ground?: string;
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
        <Line x1={0} x2={width} y1={baseY} y2={baseY} stroke={faded} strokeWidth={1} strokeDasharray="2 4" />
        {at == null ? (
          <>
            <Path d={d} fill="none" stroke={ink} strokeWidth={4} strokeLinejoin="round" strokeLinecap="round" />
            <Circle cx={end.x} cy={end.y} r={10} fill={ground} />
            <Circle cx={end.x} cy={end.y} r={6} fill={ink} />
          </>
        ) : (
          <>
            <Path d={d} fill="none" stroke={faded} strokeWidth={4} strokeLinejoin="round" strokeLinecap="round" />
            {upTo && (
              <Path d={upTo.d} fill="none" stroke={ink} strokeWidth={4} strokeLinejoin="round" strokeLinecap="round" />
            )}
            <Line x1={px} x2={px} y1={0} y2={height} stroke={ink} strokeWidth={1.5} />
            <Circle cx={px} cy={py} r={11} fill={ground} />
            <Circle cx={px} cy={py} r={7} fill={ink} />
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
  change: {
    height: 28,
    paddingLeft: 8,
    paddingRight: 11,
    borderRadius: radius.pill,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
  },
  changeBare: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start' },
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
 * Wren Color stock tile: a solid card in the stock's own color, name and
 * ticker on top, a small line, the value big at the bottom with its move.
 * `footer` replaces the move (Cash: "Ready to send").
 */
export function StockTile({
  name,
  tickerText,
  value,
  change,
  colors,
  spark,
  footer,
  width,
  onPress,
}: {
  name: string;
  tickerText: string;
  value: string;
  change?: number | null;
  colors: StockColor;
  spark?: number[];
  footer?: string;
  width: number;
  onPress?: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={`${name}, ${value}`}
      style={({ pressed }) => [tileStyles.tile, { width, backgroundColor: colors.bg }, pressed && tileStyles.pressed]}
    >
      <View style={tileStyles.top}>
        <Text style={[tileStyles.name, { color: colors.ink }]} numberOfLines={1}>
          {name}
        </Text>
        <Text style={[tileStyles.ticker, { color: colors.soft }]}>{tickerText}</Text>
      </View>
      {spark && spark.length > 1 ? (
        <View style={{ marginTop: 10 }}>
          <SparkOn values={spark} width={width - 32} height={26} stroke={colors.ink} />
        </View>
      ) : null}
      <View style={{ marginTop: 'auto' }}>
        <Text style={[type.tileValue, { color: colors.ink }]} numberOfLines={1} adjustsFontSizeToFit>
          {value}
        </Text>
        <View style={tileStyles.foot}>
          {footer ? (
            <Text style={[type.caption, { color: colors.ink }]}>{footer}</Text>
          ) : (
            <Change value={change} on={colors.ink} />
          )}
        </View>
      </View>
    </Pressable>
  );
}

/** A plain line in a given color (sparklines on colored cards). */
function SparkOn({ values, width, height, stroke }: { values: number[]; width: number; height: number; stroke: string }) {
  const { d } = pathFor(values, width, height, 3);
  return (
    <Svg width={width} height={height}>
      <Path d={d} fill="none" stroke={stroke} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
    </Svg>
  );
}

/**
 * Wren Color wallet card (what you own): a full-width card in the stock's
 * color. Cards stack like a wallet, each tucked 26px under the one above.
 */
export function WalletCard({
  name,
  tickerText,
  value,
  change,
  colors,
  footer,
  first,
  onPress,
}: {
  name: string;
  tickerText: string;
  value: string;
  change?: number | null;
  colors: StockColor;
  footer?: string;
  first: boolean;
  onPress?: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={`${name}, ${value}`}
      style={({ pressed }) => [
        tileStyles.wallet,
        { backgroundColor: colors.bg, marginTop: first ? 0 : -WALLET_TUCK },
        pressed && tileStyles.pressed,
      ]}
    >
      <View style={{ flexShrink: 1 }}>
        <Text style={[tileStyles.walletName, { color: colors.ink }]} numberOfLines={1}>
          {name}
        </Text>
        <Text style={[tileStyles.ticker, { color: colors.soft, marginTop: 2 }]}>{tickerText}</Text>
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={[tileStyles.walletName, { color: colors.ink }]}>{value}</Text>
        <View style={{ marginTop: 4 }}>
          {footer ? (
            <Text style={[type.caption, { color: colors.ink }]}>{footer}</Text>
          ) : (
            <Change value={change} on={colors.ink} />
          )}
        </View>
      </View>
    </Pressable>
  );
}

const WALLET_TUCK = 26;

const tileStyles = StyleSheet.create({
  tile: { borderRadius: 28, padding: 16, minHeight: 148 },
  wallet: {
    height: 96,
    borderRadius: 30,
    paddingHorizontal: 20,
    paddingTop: 18,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
  },
  walletName: { fontFamily: font.display, fontSize: 22, lineHeight: 26, letterSpacing: -0.4 },
  pressed: { transform: [{ scale: 0.97 }] },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  name: { fontFamily: font.bold, fontSize: 17, lineHeight: 20, flexShrink: 1 },
  ticker: { ...type.ticker },
  foot: { marginTop: 8, minHeight: 24, justifyContent: 'center', alignItems: 'flex-start' },
});

/** The stock you're sending or buying, in its color, with Change. */
export function ChosenStock({
  name,
  symbol,
  onChange,
  style,
}: {
  name: string;
  symbol: string;
  onChange: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const c = stockColor(symbol);
  return (
    <View style={[chosenStyles.card, { backgroundColor: c.bg }, style]}>
      <View style={{ flexShrink: 1 }}>
        <Text style={[chosenStyles.name, { color: c.ink }]} numberOfLines={1}>
          {name}
        </Text>
        <Text style={[tileStyles.ticker, { color: c.soft }]}>{symbol.replace(/c$/, '')}</Text>
      </View>
      <Pressable
        onPress={onChange}
        accessibilityRole="button"
        accessibilityLabel={`Change stock, now ${name}`}
        hitSlop={8}
        style={({ pressed }) => [chosenStyles.change, pressed && { opacity: 0.8 }]}
      >
        <Text style={chosenStyles.changeText}>Change</Text>
      </Pressable>
    </View>
  );
}

const chosenStyles = StyleSheet.create({
  card: {
    height: 64,
    borderRadius: 24,
    paddingLeft: 18,
    paddingRight: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  name: { fontFamily: font.display, fontSize: 20, lineHeight: 24 },
  change: { height: 40, paddingHorizontal: 16, borderRadius: 999, backgroundColor: color.canvas, justifyContent: 'center' },
  changeText: { fontFamily: font.bold, fontSize: 15, color: color.ink },
});
