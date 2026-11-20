// Design tokens from design/tokens/*.css, ported to RN.
// The canvas is pure white, cards are #EEF0F3, hairlines #DEE1E7, ink #0A0B0D.
// #0000FF is reserved for the one pinned pill (Send / Continue / Home).
// Never recolor the bird to Base Blue — the bird's blues are different.

export const color = {
  // Canvas + surfaces
  canvas: '#FFFFFF',
  card: '#EEF0F3',
  pressed: '#DEE1E7',
  hairline: '#DEE1E7',

  // Ink ramp
  ink: '#0A0B0D',
  textPrimary: '#0A0B0D',
  textSecondary: '#5B616E',
  textTertiary: '#717886',
  textOnAction: '#FFFFFF',

  // The one accent
  action: '#0000FF',
  actionPressed: '#0000C8',

  // Wren (bird + people). These never leak onto the primary button.
  wrenBody: '#0050FA',
  wrenWing: '#0028C3',
  wrenBelly: '#BCCDFB',
  wrenTint: '#E3EAFE',

  // Semantic. Nov 21 2026 (Wren Color): a move is an arrow on lime or
  // coral, never a solid red pill; on a colored card it takes the card's ink.
  moveUp: '#C6F432',
  moveDown: '#FFB199',
  moveUpInk: '#2E9E00',
  moveDownInk: '#E2401C',

  // Wren Color: each stock owns one color everywhere (its wallet card, its
  // tile, its Stock page hero). Cash is always Sun.
  blue: '#0050FA',
  lime: '#C6F432',
  coral: '#FFB199',
  sun: '#FFD84D',
  lilac: '#B9A7FF',
  mint: '#7FE0C2',
  tangerine: '#FF8A3D',
} as const;

export type StockColor = { bg: string; ink: string; soft: string };

const STOCK_COLORS: StockColor[] = [
  { bg: color.blue, ink: '#FFFFFF', soft: '#BCCDFB' },
  { bg: color.lime, ink: color.ink, soft: '#3A3D44' },
  { bg: color.coral, ink: color.ink, soft: '#3A3D44' },
  { bg: color.lilac, ink: color.ink, soft: '#3A3D44' },
  { bg: color.mint, ink: color.ink, soft: '#3A3D44' },
  { bg: color.tangerine, ink: color.ink, soft: '#3A3D44' },
  { bg: color.ink, ink: '#FFFFFF', soft: '#A7ADB8' },
];

// Fixed picks for the stocks Wren sells today, so the big names never clash.
const FIXED: Record<string, number> = { AAPL: 0, NVDA: 1, TSLA: 2, META: 3, MSFT: 4, AMZN: 5, GOOGL: 6, MSTR: 3, SNDK: 4, SPCX: 6 };

/** A person's tile color: steady per name, from the same palette. */
export function personColor(name: string): StockColor {
  const i = [...name].reduce((a, ch) => a + ch.charCodeAt(0), 0) % STOCK_COLORS.length;
  return STOCK_COLORS[(i + 3) % STOCK_COLORS.length];
}

export const cashColor: StockColor = { bg: color.sun, ink: color.ink, soft: '#3A3D44' };

/** One color per stock, the same on every screen. */
export function stockColor(symbol: string): StockColor {
  const t = symbol.replace(/c$/, '').toUpperCase();
  const i = FIXED[t] ?? [...t].reduce((a, ch) => a + ch.charCodeAt(0), 0) % STOCK_COLORS.length;
  return STOCK_COLORS[i];
}

export const radius = {
  card: 20,
  pill: 999,
  face: 999,
  // Bubble cards: 32 all round, one 8 corner (the tail).
  bubble: 32,
  bubbleTail: 8,
  tile: 24,
} as const;

// Every screen: a 44px top bar (back arrow, the logo on Welcome, or empty),
// then the headline 12px below it. Same spot on every screen.
export const layout = {
  topBar: 44,
  titleGap: 12,
} as const;

export const spacing = {
  screenPad: 24,
  homeIndicator: 34,
  buttonHLg: 60,
  hitMin: 44,
} as const;

// Font families — loaded in App.tsx via @expo-google-fonts/*
// Wren Color (Nov 21 2026): Bricolage Grotesque for names, money and body
// (extra bold for headlines and numbers), DM Mono for tickers and percents.
export const font = {
  display: 'BricolageGrotesque_800ExtraBold',
  displayRegular: 'BricolageGrotesque_400Regular',
  bold: 'BricolageGrotesque_700Bold',
  ui: 'BricolageGrotesque_500Medium',
  uiRegular: 'BricolageGrotesque_400Regular',
  uiSemiBold: 'BricolageGrotesque_700Bold',
  mono: 'DMMono_400Regular',
  monoMedium: 'DMMono_500Medium',
} as const;

// Base headline spec: medium, −3% tracking, 100% leading.
export const type = {
  // One per screen. Medium, −4% tracking, 98% leading.
  headline: { fontFamily: font.display, fontSize: 52, lineHeight: 51, letterSpacing: -52 * 0.04 },
  headlineXl: { fontFamily: font.display, fontSize: 64, lineHeight: 62, letterSpacing: -64 * 0.04 },
  tileName: { fontFamily: font.display, fontSize: 40, lineHeight: 40, letterSpacing: -40 * 0.04 },
  bubble: { fontFamily: font.ui, fontSize: 19, lineHeight: 25 },
  total: { fontFamily: font.display, fontSize: 64, lineHeight: 64, letterSpacing: -64 * 0.03 },
  // Wren Bold (B7): the balance on Account and the price on a Stock page.
  balance: { fontFamily: font.display, fontSize: 72, lineHeight: 78, letterSpacing: -72 * 0.05 },
  // Wren Bold (B7): the value on a stock tile.
  tileValue: { fontFamily: font.display, fontSize: 28, lineHeight: 32, letterSpacing: -26 * 0.03 },
  amount: { fontFamily: font.display, fontSize: 88, lineHeight: 88, letterSpacing: -88 * 0.03 },
  // Nov 2026: the amount inside its bubble, and the name on Sent.
  amountXl: { fontFamily: font.display, fontSize: 104, lineHeight: 102, letterSpacing: -104 * 0.04 },
  nameXl: { fontFamily: font.display, fontSize: 96, lineHeight: 94, letterSpacing: -96 * 0.04 },
  name: { fontFamily: font.display, fontSize: 48, lineHeight: 48, letterSpacing: -48 * 0.03 },
  nameLg: { fontFamily: font.display, fontSize: 56, lineHeight: 56, letterSpacing: -56 * 0.03 },
  title: { fontFamily: font.ui, fontSize: 32, lineHeight: 38, letterSpacing: -32 * 0.02 },
  titleSm: { fontFamily: font.ui, fontSize: 26, lineHeight: 29, letterSpacing: -26 * 0.02 },
  body: { fontFamily: font.ui, fontSize: 17, lineHeight: 24 },
  bodyRegular: { fontFamily: font.uiRegular, fontSize: 17, lineHeight: 24 },
  label: { fontFamily: font.ui, fontSize: 15, lineHeight: 20 },
  caption: { fontFamily: font.uiRegular, fontSize: 13, lineHeight: 18 },
  button: { fontFamily: font.uiSemiBold, fontSize: 18, lineHeight: 18 },
  key: { fontFamily: font.uiRegular, fontSize: 28, lineHeight: 28 },
  ticker: { fontFamily: font.mono, fontSize: 13, lineHeight: 16 },
  price: { fontFamily: font.mono, fontSize: 16, lineHeight: 22 },
  percent: { fontFamily: font.monoMedium, fontSize: 13, lineHeight: 16 },
} as const;
