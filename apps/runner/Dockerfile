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


FROM debian:bookworm-slim AS binaries

ARG TARGETARCH
ARG PROMETHEUS_VERSION=2.53.0
ARG ALERTMANAGER_VERSION=0.32.1
ARG CADVISOR_VERSION=0.51.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN ARCH=$(case "$TARGETARCH" in arm64) echo "arm64";; *) echo "amd64";; esac) \
    && curl -fsSL \
       "https://github.com/prometheus/prometheus/releases/download/v${PROMETHEUS_VERSION}/prometheus-${PROMETHEUS_VERSION}.linux-${ARCH}.tar.gz" \
       | tar xzf - --strip-components=1 -C /tmp \
    && mkdir -p /opt/prometheus \
    && mv /tmp/prometheus /tmp/promtool /opt/prometheus/

RUN ARCH=$(case "$TARGETARCH" in arm64) echo "arm64";; *) echo "amd64";; esac) \
    && curl -fsSL \
       "https://github.com/prometheus/alertmanager/releases/download/v${ALERTMANAGER_VERSION}/alertmanager-${ALERTMANAGER_VERSION}.linux-${ARCH}.tar.gz" \
       | tar xzf - --strip-components=1 -C /tmp \
    && mkdir -p /opt/alertmanager \
    && mv /tmp/alertmanager /tmp/amtool /opt/alertmanager/

RUN ARCH=$(case "$TARGETARCH" in arm64) echo "arm64";; *) echo "amd64";; esac) \
    && curl -fsSL -o /tmp/cadvisor \
       "https://github.com/google/cadvisor/releases/download/v${CADVISOR_VERSION}/cadvisor-v${CADVISOR_VERSION}-linux-${ARCH}" \
    && chmod +x /tmp/cadvisor \
    && mkdir -p /opt/cadvisor \
    && mv /tmp/cadvisor /opt/cadvisor/cadvisor


FROM node:24-slim

ARG TARGETARCH
ARG S6_OVERLAY_VERSION=3.2.0.2

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       curl \
       procps \
       sysstat \
       iproute2 \
       util-linux \
       docker.io \
       gettext-base \
       ca-certificates \
       xz-utils \
    && rm -rf /var/lib/apt/lists/*

RUN S6_ARCH=$(case "$TARGETARCH" in arm64) echo "aarch64";; *) echo "x86_64";; esac) \
    && curl -fsSL "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz" \
       -o /tmp/s6-noarch.tar.xz \
    && curl -fsSL "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-${S6_ARCH}.tar.xz" \
       -o /tmp/s6-arch.tar.xz \
    && tar -C / -Jxpf /tmp/s6-noarch.tar.xz \
    && tar -C / -Jxpf /tmp/s6-arch.tar.xz \
    && rm /tmp/s6-*.tar.xz

COPY --from=binaries /opt/prometheus/ /opt/prometheus/
COPY --from=binaries /opt/alertmanager/ /opt/alertmanager/
COPY --from=binaries /opt/cadvisor/ /opt/cadvisor/

COPY --from=builder /app /app

COPY apps/runner/install/s6/init-configure/ /etc/s6-overlay/s6-rc.d/init-configure/
COPY apps/runner/install/s6/runner/ /etc/s6-overlay/s6-rc.d/runner/
COPY apps/runner/install/s6/prometheus/ /etc/s6-overlay/s6-rc.d/prometheus/
COPY apps/runner/install/s6/alertmanager/ /etc/s6-overlay/s6-rc.d/alertmanager/
COPY apps/runner/install/s6/cadvisor/ /etc/s6-overlay/s6-rc.d/cadvisor/

RUN touch /etc/s6-overlay/s6-rc.d/user/contents.d/init-configure \
          /etc/s6-overlay/s6-rc.d/user/contents.d/runner \
          /etc/s6-overlay/s6-rc.d/user/contents.d/prometheus \
          /etc/s6-overlay/s6-rc.d/user/contents.d/alertmanager \
          /etc/s6-overlay/s6-rc.d/user/contents.d/cadvisor

RUN for svc in runner prometheus alertmanager cadvisor; do \
      mkdir -p "/etc/s6-overlay/s6-rc.d/${svc}/dependencies.d" \
      && touch "/etc/s6-overlay/s6-rc.d/${svc}/dependencies.d/init-configure"; \
    done

COPY apps/runner/install/configs/ /etc/nightwatch/templates/
COPY apps/runner/install/configure.sh /etc/nightwatch/configure.sh

RUN chmod +x /etc/nightwatch/configure.sh \
             /etc/s6-overlay/s6-rc.d/runner/run \
             /etc/s6-overlay/s6-rc.d/prometheus/run \
             /etc/s6-overlay/s6-rc.d/alertmanager/run \
             /etc/s6-overlay/s6-rc.d/cadvisor/run

RUN mkdir -p /var/nightwatch

ENV S6_KEEP_ENV=1
ENV S6_BEHAVIOUR_IF_STAGE2_FAILS=2
ENV S6_CMD_WAIT_FOR_SERVICES_MAXTIME=30000

ENV HOST_PROC=/host/proc

EXPOSE 9090 9093 8080

ENTRYPOINT ["/init"]
