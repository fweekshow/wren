# Build context is the monorepo root so workspace deps resolve.
# Channels bot — iMessage + WhatsApp.
#
# Photon's iMessage gRPC requires HTTP/2. Bun's http2 client fails with
# "h2 is not supported" / SendTextMessage UNAVAILABLE on Railway.
# Same pattern as basemate-tba: install with Bun, run the process on Node 22.
FROM --platform=linux/amd64 oven/bun:1.2 AS deps

WORKDIR /app

COPY . .
RUN if [ -f bun.lock ]; then bun install --frozen-lockfile; else bun install; fi

FROM --platform=linux/amd64 node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=deps /app /app
COPY --from=deps /usr/local/bin/bun /usr/local/bin/bun

ENV NODE_ENV=production
ENV NODE_OPTIONS=--dns-result-order=ipv4first

# Bun only runs Drizzle migrations. Node owns Spectrum / Photon gRPC.
CMD sh -c 'bun --cwd packages/core run db:migrate && node --import tsx --dns-result-order=ipv4first apps/channels-server/src/index.ts'
