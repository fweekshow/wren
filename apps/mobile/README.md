# Wren

iOS app. Pick someone you know and send them a stock.

An [Expo](https://expo.dev) app at the repo root. The design system that drives
every pixel lives in [`design/`](./design) — read
[`design/readme.md`](./design/readme.md) for the content and visual rules. The
mascot used on every screen is [`design/assets/wren.png`](./design/assets/wren.png);
a copy is wired through `assets/wren.png` for the Expo splash + icon. The orange
birds in `design/uploads/` are retired.

This repo is the app only. The server (iMessage + WhatsApp channels, stock
gifts, Apple Pay handoff) lives in the separate `basemate-v2` and
`basemate-metrics` workspaces and is not touched here.

## Screens

1. **Sign in.** Native, via [Privy](https://privy.io) email + one-time code.
   No web handoff. On success we mirror `{ user: user.id, token:
   getAccessToken() }` into `SecureStore` so the request layer (which runs
   outside React) can read it.
2. **Home.** The total and the stock rows from `GET /api/app/portfolio`. Send
   stays if the request fails or the portfolio is empty.
3. **Someone.** `expo-contacts`. Search matches first and last name. Email-only
   contacts are hidden. Numbers without `+` open a country sheet instead of
   advancing to Amount. Contacts whose numbers normalize to E.164 are imported
   to `POST /api/app/contacts/import` in chunks under 80 kb.
4. **Amount.** Stock pills from `GET /api/app/stocks` (one horizontally
   scrolling row, company name on the pill), presets $25 / $50 / $100, a
   keypad, and an Apple-Pay-only Continue. One `POST /api/app/stock-gifts` on
   Continue with `channel: "imessage"`, the symbol as-returned, the dollars,
   and the recipient. The returned `payUrl` is opened with `Linking.openURL`
   (not a webview). The screen stays with **Finish in Safari** while we poll
   `GET /api/muse/sends/:giftId`.
5. **Sent.** Shown only once the send status is `sent`. Under the name, the
   dollars and the company, then one line: *It's in their Wren.* if the
   recipient already has an account, otherwise *They'll get a text.* Home is
   the only button.

## Run a dev build

You need an Apple Developer account (free is fine) and
[Xcode](https://apps.apple.com/us/app/xcode/id497799835). Expo SDK 58 requires
Node ≥ 22.13.

```bash
npm install                     # one-time
npx expo prebuild               # generates the native ios/ and android/ folders
npm run ios                     # builds the dev client and opens it in the simulator
```

Or use EAS to put a dev build on a real device:

```bash
npm i -g eas-cli
eas build --profile development --platform ios
```

After the first build, iterate with:

```bash
npm run start                   # starts Metro
# then re-open the installed Wren dev client on the simulator/device
```

Typecheck:

```bash
npm run typecheck
```

## Environment

Three variables, all `EXPO_PUBLIC_*` so the client can read them:

```bash
# .env.local (or your shell before `npm run start`)
EXPO_PUBLIC_WREN_API_HOST=https://your-channels-host.example.com
EXPO_PUBLIC_PRIVY_APP_ID=<your Privy app id>
EXPO_PUBLIC_PRIVY_CLIENT_ID=<your Privy client id>   # optional, per Privy
```

- `EXPO_PUBLIC_WREN_API_HOST` **must be the channels / iMessage host** — the
  Express service that mounts `/api/app/*` and `/api/muse/*` (see
  `packages/core/src/entries/channelsApp.ts` in `basemate-v2`). It is **not**
  the xmtp-agent URL. Don't hardcode a Railway URL; pass it via the
  environment so preview and prod can point at different deployments.
- `EXPO_PUBLIC_PRIVY_APP_ID` / `EXPO_PUBLIC_PRIVY_CLIENT_ID` come from the
  Privy dashboard (**App settings → App ID** / **Clients**).

With `EXPO_PUBLIC_WREN_API_HOST` unset the app still builds, signs in with
Privy, and renders every screen; it just can't fetch or post anything (Home
keeps *Send*, Amount restores *Continue*, etc).

> **Server note.** Today the server's `/api/app/*` routes authenticate on the
> `{user, token}` CDP session minted by `/api/agent/app/session`. Moving Wren
> to Privy means the server needs to accept a Privy access token under the
> same `{user, token}` contract (or mint its own session from the Privy
> identity token). That change is out of scope for this repo — track it in
> the channels service, not here.

## iOS permissions

- `NSContactsUsageDescription` is set to *Allow contacts to choose someone.*
  on first prompt. If denied, the Someone screen shows the same line and a
  single **Settings** button that calls `Linking.openSettings()`.
- The `wren://` scheme is registered for future deep links (notifications,
  shared links). It is no longer required for sign in.

## Layout of the code

```
index.ts                       Privy polyfills, then registerRootComponent
App.tsx                        PrivyProvider + screen state + fonts
src/api.ts                     typed client for /api/app/* and /api/muse/*
src/auth.ts                    SecureStore mirror of the Privy session
src/contacts.ts                load + normalize + search the address book
src/countries.ts               the short country dial-code list
src/theme.ts                   tokens (colors, type, spacing) from design/
src/components/                Wren, Button, BigNumber, StockRow, Avatar, …
src/screens/                   SignIn, Home, Someone, Country, Amount, Sent
```

## Things it intentionally doesn't do

- Never says *Basemate*, *wallet*, *gas*, *USDC*, *onchain*, *escrow*,
  *claim*, or *token*. The audit covers every rendered string.
- Doesn't guess the country code for a bare phone number — the country sheet
  opens instead.
- Doesn't try to fix the pay page; the `https` URL is opened in Safari as-is.
- No App Store submission from this repo.
