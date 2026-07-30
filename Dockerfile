# syntax=docker/dockerfile:1

FROM node:24-slim AS base

RUN corepack enable pnpm

# Non-interactive, so approved build scripts run without a prompt.
ENV CI=true

WORKDIR /build


# better-sqlite3 and argon2 compile native bindings.
FROM base AS toolchain

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*


# Manifests alone are what pnpm resolves against, so this layer stays cached
# until a dependency actually changes rather than on every source edit.
FROM toolchain AS manifests

# --frozen-lockfile resolves the whole workspace, so every member's manifest must
# be here even when this image ships none of its code.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/console/package.json apps/console/
COPY apps/docker-runner/package.json apps/docker-runner/
COPY apps/kubernetes-runner/package.json apps/kubernetes-runner/
COPY packages/shared/package.json packages/shared/
COPY packages/runner-transport/package.json packages/runner-transport/


# The tree the image ships: it never sees a devDependency, so nothing needs
# pruning - `--prod` decides what to install and cannot uninstall. Filtered to
# the api, or it also installs the console's React tree that Vite has bundled.
FROM manifests AS prod-deps

# The store is a build cache, so a package is fetched once across every stage of
# every image rather than once per install.

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --store-dir=/pnpm/store \
      --filter @nightwarden/api


# The full install, used only to produce dist and then discarded. Filtered to the
# two workspaces this image builds, so no runner's dependencies are fetched.
FROM manifests AS build

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store \
      --filter @nightwarden/api... --filter @nightwarden/console...

COPY tsconfig.base.json ./
COPY scripts/ scripts/
COPY packages/shared/ packages/shared/
COPY apps/api/ apps/api/
COPY apps/console/ apps/console/

# One image, one origin: the API serves the console from beside its bundle.
RUN pnpm --filter @nightwarden/console build \
    && pnpm --filter @nightwarden/api build \
    && cp -r apps/console/dist apps/api/dist/console


FROM base AS runtime

# git for the per-session repo checkout; ca-certificates for outbound TLS to the
# LLM, GitHub, and the monitoring integrations.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       git \
       ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# pnpm links each package as a relative symlink into the virtual store, so these
# must land at the same depth they had under /build or they resolve to nothing.
COPY --from=prod-deps /build/node_modules ./node_modules
COPY --from=prod-deps /build/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /build/apps/api/dist ./apps/api/dist

# 127.0.0.1 would make the API unreachable outside the container's namespace.
ENV HOST=0.0.0.0
ENV PORT=3000
ENV NODE_ENV=production
ENV NIGHTWARDEN_DIR=/opt/nightwarden
# The bundle ships a sourcemap; without this a stack trace names a line in the
# bundle instead of the file it came from.
ENV NODE_OPTIONS=--enable-source-maps

EXPOSE 3000

ENTRYPOINT ["node", "apps/api/dist/index.js"]
