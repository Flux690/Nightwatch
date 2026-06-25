#!/bin/sh
set -e

PLATFORM_URL="${PLATFORM_URL:?PLATFORM_URL is required}"
NIGHTWATCH_TOKEN="${NIGHTWATCH_TOKEN:?NIGHTWATCH_TOKEN is required}"

mkdir -p /var/nightwatch/prometheus /var/nightwatch/alertmanager /etc/nightwatch

if [ -n "$ALERTMANAGER_URL" ]; then
  ALERTMANAGER_TARGET=$(echo "$ALERTMANAGER_URL" | sed 's|^https\?://||' | sed 's|/.*||')
else
  ALERTMANAGER_TARGET="localhost:9093"
fi

# Fleet-wide nwi_ ingest credential for Alertmanager webhook auth.
# Falls back to the runner's own nwr_ token when no fleet credential is
# configured (backward compat - the ingest endpoint accepts both token types).
NIGHTWATCH_INGEST_TOKEN="${NIGHTWATCH_INGEST_TOKEN:-$NIGHTWATCH_TOKEN}"

# Hostname stamped as the "instance" external_label in Prometheus so every
# alert carries the server dimension for fleet-wide identity matching.
RUNNER_HOSTNAME=$(hostname -f 2>/dev/null || hostname)

export ALERTMANAGER_TARGET PLATFORM_URL NIGHTWATCH_TOKEN NIGHTWATCH_INGEST_TOKEN RUNNER_HOSTNAME

if [ -z "$PROMETHEUS_URL" ]; then
  envsubst < /etc/nightwatch/templates/prometheus.yml > /etc/nightwatch/prometheus.yml
  echo "http://localhost:9090" > /run/s6/container_environment/PROMETHEUS_URL
fi

if [ -z "$ALERTMANAGER_URL" ]; then
  envsubst < /etc/nightwatch/templates/alertmanager.yml > /etc/nightwatch/alertmanager.yml
fi

# Prefer a persisted rules override (written by update_alert_rules and kept on
# the mounted volume) so user threshold changes survive restarts; else defaults.
if [ -f /var/nightwatch/rules.yml ]; then
  cp /var/nightwatch/rules.yml /etc/nightwatch/rules.yml
else
  cp /etc/nightwatch/templates/rules.yml /etc/nightwatch/rules.yml
fi

echo "nightwatch configured:"
echo "  prometheus: ${PROMETHEUS_URL:-http://localhost:9090 (bundled)}"
echo "  alertmanager: ${ALERTMANAGER_URL:-http://localhost:9093 (bundled)}"
echo "  platform: ${PLATFORM_URL}"
