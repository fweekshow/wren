# Coinbase Offramp rollout

## Required channels-service configuration

- `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET`
- `CDP_FUND_PAGE_URL=https://basemate.app/pay`
- `CDP_OFFRAMP_REDIRECT_URL=https://basemate.app/pay/offramp/return`
- `CDP_PAY_PAGE_ORIGIN=https://basemate.app`
- `CDP_WALLET_SECRET` for embedded-wallet delegated signing
- `BASE_RPC_URL` and `DATABASE_URL`

Set `CHANNELS_API_HOST` on `basemate-metrics` to the private or public channels-service origin. Do not expose CDP credentials through `NEXT_PUBLIC_*` variables.

## CDP Portal checklist

- Allowlist `basemate.app` for production Offramp redirects.
- Use the matching sandbox or production CDP API key pair.
- Confirm USDC on Base is enabled for the project.
- Keep the exact redirect URL in CDP and `CDP_OFFRAMP_REDIRECT_URL` synchronized.

## Sandbox smoke test

1. Apply Drizzle migration `0005_majestic_paper_doll.sql`.
2. Connect a CDP Embedded Wallet and complete delegation.
3. Send `cash out 1 USDC` in each enabled channel.
4. Verify the chat link contains only an opaque `o` capability and no Coinbase session token.
5. Open the link and verify Coinbase is launched at that moment with a 5-minute session token.
6. Complete the hosted order and verify Basemate shows the exact USDC amount, fiat total, fee, and Base destination.
7. Submit the embedded-wallet transfer and verify a single terminal chat receipt.
8. Repeat with an expired link, wrong origin, amount mismatch, and expired delegation.

## Production gate

- Run focused Vitest suites and both application typechecks/builds.
- Verify one low-value Base USDC cash out end to end.
- Confirm iMessage and WhatsApp terminal receipts remain platform-scoped.
- Confirm logs contain session IDs only: never session tokens, capability tokens, approval URLs, or complete Coinbase payloads.
- Monitor `offramp_sessions` for `manual_review`, `failed`, and stale active rows before increasing traffic.
