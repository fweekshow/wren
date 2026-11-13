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

  // Semantic
  moveUp: '#66C800',
  moveDown: '#FC401F',
} as const;

export const radius = {
  card: 20,
  pill: 999,
  face: 999,
} as const;

export const spacing = {
  screenPad: 24,
  homeIndicator: 34,
  buttonHLg: 60,
  hitMin: 44,
} as const;

// Font families — loaded in App.tsx via @expo-google-fonts/*
// Inter Tight: names, money, body. Roboto Mono: tickers, prices, percents.
export const font = {
  display: 'InterTight_500Medium',
  displayRegular: 'InterTight_400Regular',
  ui: 'InterTight_500Medium',
  uiRegular: 'InterTight_400Regular',
  uiSemiBold: 'InterTight_600SemiBold',
  mono: 'RobotoMono_400Regular',
  monoMedium: 'RobotoMono_500Medium',
} as const;

// Base headline spec: medium, −3% tracking, 100% leading.
export const type = {
  total: { fontFamily: font.display, fontSize: 64, lineHeight: 64, letterSpacing: -64 * 0.03 },
  amount: { fontFamily: font.display, fontSize: 88, lineHeight: 88, letterSpacing: -88 * 0.03 },
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
  percent: { fontFamily: font.monoMedium, fontSize: 12, lineHeight: 16 },
} as const;
