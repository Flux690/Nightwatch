FROM node:24-slim AS builder

# better-sqlite3 and argon2 compile native bindings.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable pnpm

# Non-interactive: lets pnpm re-link node_modules for the prod prune below.
ENV CI=true

WORKDIR /build
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY scripts/ scripts/
COPY packages/shared/ packages/shared/
COPY apps/api/ apps/api/
COPY apps/console/ apps/console/

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @nightwarden/console build
RUN pnpm --filter @nightwarden/api build
# One image, one origin: the API serves the console from beside its bundle.
RUN cp -r apps/console/dist apps/api/dist/console
# shared is inlined, so pruning leaves exactly what the bundle imports. Copied
# whole because pnpm's node_modules are relative symlinks into the store.
RUN pnpm install --frozen-lockfile --prod


FROM node:24-slim

# git for the per-session repo checkout; ca-certificates for outbound TLS to the
# LLM, GitHub, and the monitoring integrations.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       git \
       ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build /app
WORKDIR /app

# 127.0.0.1 would make the API unreachable outside the container's namespace.
ENV HOST=0.0.0.0
ENV PORT=3000
ENV NODE_ENV=production
ENV NIGHTWARDEN_DIR=/opt/nightwarden

EXPOSE 3000

ENTRYPOINT ["node", "apps/api/dist/index.js"]
