# syntax=docker/dockerfile:1

FROM node:24-slim AS base

RUN corepack enable pnpm

# Non-interactive, so approved build scripts run without a prompt.
ENV CI=true

WORKDIR /build


# No compiler stage: nothing in this runner's tree has a native binding to build.
# Manifests alone are what pnpm resolves against, so this layer stays cached
# until a dependency actually changes rather than on every source edit.
FROM base AS manifests

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/kubernetes-runner/package.json apps/kubernetes-runner/
COPY packages/shared/package.json packages/shared/
COPY packages/runner-transport/package.json packages/runner-transport/


# The tree the image ships. It never sees a devDependency, so there is nothing
# to prune afterwards - `--prod` decides what to install, and cannot uninstall.
FROM manifests AS prod-deps

# The store is a build cache, so a package is fetched once across every stage of
# every image rather than once per install.

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --store-dir=/pnpm/store \
      --filter @nightwarden/kubernetes-runner


# The full install, used only to produce dist and then discarded.
FROM manifests AS build

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store

COPY tsconfig.base.json ./
COPY scripts/ scripts/
COPY packages/shared/ packages/shared/
COPY packages/runner-transport/ packages/runner-transport/
COPY apps/kubernetes-runner/ apps/kubernetes-runner/

RUN pnpm --filter @nightwarden/kubernetes-runner build


FROM base AS runtime

# ca-certificates for the outbound WSS dial, and nothing else: this runner reads a
# cluster through its API server, so it needs none of the host tooling a Docker
# runner does, and ships no dockerode.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# pnpm links each package as a relative symlink into the virtual store, so these
# must land at the same depth they had under /build or they resolve to nothing.
COPY --from=prod-deps --chown=node:node /build/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /build/apps/kubernetes-runner/node_modules ./apps/kubernetes-runner/node_modules
COPY --from=build --chown=node:node /build/apps/kubernetes-runner/dist ./apps/kubernetes-runner/dist

# The bundle ships a sourcemap; without this a stack trace names a line in the
# bundle instead of the file it came from.
ENV NODE_OPTIONS=--enable-source-maps

# Unprivileged, unlike the Docker runner: this one reaches its cluster through the
# API server with a ServiceAccount token and touches no host socket or filesystem.
USER node

ENTRYPOINT ["node", "apps/kubernetes-runner/dist/index.js"]
