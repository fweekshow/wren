# Wren

Sign in, connect iMessage or WhatsApp, pay, and send stocks. The app talks about cash and stocks.

## Run the phone app

```bash
cd apps/mobile
cp .env.example .env   # if you keep one
npm install
npx expo start --dev-client
```

Set these in `apps/mobile/.env` (they are public in the client bundle):

- `EXPO_PUBLIC_PRIVY_APP_ID`
- `EXPO_PUBLIC_PRIVY_CLIENT_ID`
- `EXPO_PUBLIC_PRIVY_SIGNER_ID` (optional, for server sends)
- `EXPO_PUBLIC_WREN_API_HOST` — the channels server, never a hardcoded host in source
- `EXPO_PUBLIC_SENTRY_DSN` (optional)

A dev build is required for contacts, notifications, and sign-in:

```bash
cd apps/mobile
npx expo run:ios
```

## Run the server

```bash
bun install
bun run dev:channels
```

The channels server reads the same environment the previous service used, plus:

- `PRIVY_APP_ID`
- `PRIVY_APP_SECRET`
- `WREN_IMESSAGE_NUMBER`
- `WREN_WHATSAPP_NUMBER`

`WREN_SIGNER=cdp` keeps the previous signer for one release. The default signer is Privy.

## Ship a TestFlight build

```bash
cd apps/mobile
npx eas build -p ios --profile preview
npx eas submit -p ios --profile production
```

Before that build:

1. Register bundle id `app.basemate.wren` in App Store Connect.
2. Add that bundle id to the Privy dashboard.
3. Create a Railway service from `apps/channels-server` and set `EXPO_PUBLIC_WREN_API_HOST` to its public URL in the EAS preview and production env.
4. In the Photon dashboard, submit the utility template `wren_stock_gift_claim` (English, three body fields, one link button).
5. Turn on card and bank payments in the Privy dashboard.

Terms and privacy are served by the channels server at `/terms` and `/privacy`.
