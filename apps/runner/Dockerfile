FROM node:24-slim AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable pnpm

WORKDIR /build
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY apps/runner/ apps/runner/

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @nightwatch/shared build
RUN pnpm --filter @nightwatch/runner build
RUN pnpm deploy --filter @nightwatch/runner --prod /app


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

COPY --from=builder /app /app
WORKDIR /app

ENV HOST_PROC=/host/proc

ENTRYPOINT ["node", "dist/index.js"]
