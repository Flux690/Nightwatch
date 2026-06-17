#!/usr/bin/env bash
# {{PLATFORM_URL}}, {{WS_URL}}, and {{NIGHTWATCH_TOKEN}} are substituted at
# serve time by GET /connect.sh — do not edit them here.
set -euo pipefail

IMAGE="${NIGHTWATCH_IMAGE:-nightwatch/runner:latest}"
CONTAINER_NAME="nightwatch"
PLATFORM_URL="{{PLATFORM_URL}}"
WS_URL="{{WS_URL}}"
NIGHTWATCH_TOKEN="{{NIGHTWATCH_TOKEN}}"

detect_service() {
  local port="$1" health_path="$2"

  if docker ps --format '{{.Ports}}' 2>/dev/null | grep -q ":${port}->"; then
    if curl -sf --max-time 2 "http://localhost:${port}${health_path}" >/dev/null 2>&1; then
      echo "http://localhost:${port}"
      return 0
    fi
  fi

  if curl -sf --max-time 2 "http://localhost:${port}${health_path}" >/dev/null 2>&1; then
    echo "http://localhost:${port}"
    return 0
  fi

  return 1
}

echo "Detecting existing monitoring stack..."
echo ""

PROMETHEUS_URL=""
ALERTMANAGER_URL=""

if result=$(detect_service 9090 "/-/healthy"); then
  PROMETHEUS_URL="$result"
  echo "  Prometheus:   found at $PROMETHEUS_URL"
else
  echo "  Prometheus:   not found, will start bundled"
fi

if result=$(detect_service 9093 "/-/healthy"); then
  ALERTMANAGER_URL="$result"
  echo "  Alertmanager: found at $ALERTMANAGER_URL"
else
  echo "  Alertmanager: not found, will start bundled"
fi

echo ""

echo "Pulling ${IMAGE}..."
docker pull "$IMAGE"

if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  echo "Stopping existing ${CONTAINER_NAME} container..."
  docker rm -f "$CONTAINER_NAME" >/dev/null
fi

DOCKER_ARGS=(
  run -d
  --name "$CONTAINER_NAME"
  --restart unless-stopped
  --pid=host
  --security-opt=no-new-privileges

  -v /var/run/docker.sock:/var/run/docker.sock:ro
  -v /proc:/host/proc:ro
  -v /sys:/sys:ro
  -v /var/lib/docker:/var/lib/docker:ro
  -v /:/rootfs:ro
  -v nightwatch-data:/var/nightwatch

  -e "NIGHTWATCH_TOKEN=${NIGHTWATCH_TOKEN}"
  -e "WS_URL=${WS_URL}"
  -e "PLATFORM_URL=${PLATFORM_URL}"
  -e "HOST_PROC=/host/proc"
  -e "NIGHTWATCH_DB_PATH=/var/nightwatch/history.db"
  -e "REMEDIATION_ENABLED=${REMEDIATION_ENABLED:-false}"
)

if [ -n "$PROMETHEUS_URL" ]; then
  DOCKER_ARGS+=(-e "PROMETHEUS_URL=${PROMETHEUS_URL}")
fi
if [ -n "$ALERTMANAGER_URL" ]; then
  DOCKER_ARGS+=(-e "ALERTMANAGER_URL=${ALERTMANAGER_URL}")
fi

if [ -z "$PROMETHEUS_URL" ]; then
  DOCKER_ARGS+=(-p "9090:9090")
fi
if [ -z "$ALERTMANAGER_URL" ]; then
  DOCKER_ARGS+=(-p "9093:9093")
fi
DOCKER_ARGS+=(-p "8080:8080")

DOCKER_ARGS+=("$IMAGE")

echo "Starting Nightwatch..."
docker "${DOCKER_ARGS[@]}"

echo ""
echo "Nightwatch is running."
echo ""
echo "  Container:    ${CONTAINER_NAME}"
echo "  Platform:     ${PLATFORM_URL}"
echo "  Prometheus:   ${PROMETHEUS_URL:-http://localhost:9090 (bundled)}"
echo "  Alertmanager: ${ALERTMANAGER_URL:-http://localhost:9093 (bundled)}"
echo "  cAdvisor:     http://localhost:8080"
echo ""

if [ -n "$ALERTMANAGER_URL" ]; then
  echo "You are using your own Alertmanager."
  echo "Add this receiver to route alerts to Nightwatch:"
  echo ""
  echo "  receivers:"
  echo "    - name: nightwatch"
  echo "      webhook_configs:"
  echo "        - url: '${PLATFORM_URL}/alerts/ingest?token=${NIGHTWATCH_TOKEN}'"
  echo ""
fi

echo "Logs: docker logs -f ${CONTAINER_NAME}"
