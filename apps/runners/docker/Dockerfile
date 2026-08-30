# syntax=docker/dockerfile:1

FROM node:24-slim AS base

RUN corepack enable pnpm

# Non-interactive, so approved build scripts run without a prompt.
ENV CI=true

WORKDIR /build


# ssh2 compiles an optional crypto binding, reached through dockerode. Only the
# install stages descend from here, so no compiler reaches the shipped image.
FROM base AS toolchain

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*


# Manifests alone are what pnpm resolves against, so this layer stays cached
# until a dependency actually changes rather than on every source edit.
FROM toolchain AS manifests

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/runners/docker/package.json apps/runners/docker/
COPY packages/shared/package.json packages/shared/
COPY packages/runner-core/package.json packages/runner-core/


# The tree the image ships. It never sees a devDependency, so there is nothing
# to prune afterwards - `--prod` decides what to install, and cannot uninstall.
FROM manifests AS prod-deps

# The store is a build cache, so a package is fetched once across every stage of
# every image rather than once per install.

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --store-dir=/pnpm/store \
      --filter @nightwarden/docker-runner


# The full install, used only to produce dist and then discarded.
FROM manifests AS build

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store

COPY tsconfig.base.json ./
COPY scripts/ scripts/
COPY packages/shared/ packages/shared/
COPY packages/runner-core/ packages/runner-core/
COPY apps/runners/docker/ apps/runners/docker/

RUN pnpm --filter @nightwarden/docker-runner build


FROM base AS runtime

# Host metrics tooling plus ca-certificates for the outbound WSS dial. No docker
# package: dockerode speaks to the mounted socket, nothing shells out to a binary.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       procps \
       sysstat \
       iproute2 \
       util-linux \
       ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# pnpm links each package as a relative symlink into the virtual store, so these
# must land at the same depth they had under /build or they resolve to nothing.
COPY --from=prod-deps /build/node_modules ./node_modules
COPY --from=prod-deps /build/apps/runners/docker/node_modules ./apps/runners/docker/node_modules
COPY --from=build /build/apps/runners/docker/dist ./apps/runners/docker/dist
# Publishing an image is redistribution, which the licence requires carry it.
COPY LICENSE NOTICE ./

ENV HOST_PROC=/host/proc
# The bundle ships a sourcemap; without this a stack trace names a line in the
# bundle instead of the file it came from.
ENV NODE_OPTIONS=--enable-source-maps

# Root, because the Docker socket and host /proc are root-owned and this runner
# reads both. The socket is mounted read-only and no capability is added.
ENTRYPOINT ["node", "apps/runners/docker/dist/index.js"]
