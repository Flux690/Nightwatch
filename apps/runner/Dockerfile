FROM node:24-slim AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable pnpm

# A build is non-interactive: lets pnpm re-link node_modules for the prod prune
# below instead of stopping to ask.
ENV CI=true

WORKDIR /build
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY scripts/ scripts/
COPY packages/shared/ packages/shared/
COPY apps/runner/ apps/runner/

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @nightwarden/runner build
# shared is inlined in the bundle, so no workspace package is left to resolve and
# pruning leaves exactly what the bundle imports. The tree is copied whole because
# pnpm's node_modules are relative symlinks into the store.
RUN pnpm install --frozen-lockfile --prod


FROM node:24-slim

# Runtime deps for host metrics (procps/sysstat/iproute2/util-linux) and the
# Docker socket (docker.io CLI); ca-certificates for the outbound WSS dial.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       procps \
       sysstat \
       iproute2 \
       util-linux \
       docker.io \
       ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build /app
WORKDIR /app

ENV HOST_PROC=/host/proc

ENTRYPOINT ["node", "apps/runner/dist/index.js"]
