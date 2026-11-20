# Discovery Tools

This directory contains the AI tool definitions registered with the DiscoveryAI agent.

## Structure

- `ai/toolbox.ts` — ~4,800-line dispatcher that registers all tools with the OpenAI function-calling API and implements each tool's handler. This is the current monolith and the primary target for the next decomposition phase (see E2 in the audit plan).
- `ai/tools/` — Individual tool modules extracted so far (wallet, yield, avantis, portfolio).
- `ai/core.ts` — DiscoveryAI orchestration: builds the system prompt, calls OpenAI, routes the response.
- `ai/types.ts` — All types for the AI system (re-exports canonical types from `@basemate/shared`).

## Next Steps (E2 — Decompose toolbox.ts)

`toolbox.ts` is the new god-file after `ai.ts` was decomposed. Planned extraction targets:

- `tools/wallet.handlers.ts` — wallet balance, send, swap
- `tools/yield.handlers.ts` — Moonwell, Morpho, Aave, Aerodrome
- `tools/avantis.handlers.ts` — open/close/manage perps
- `tools/portfolio.handlers.ts` — portfolio review, copy-trading

Leave `toolbox.ts` as a ~300–500 line dispatcher that imports from these handler modules.
