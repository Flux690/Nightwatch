#!/usr/bin/env bash
# The {{...}} placeholders are substituted at serve time by GET /connect.sh -
# do not edit them here. NIGHTWATCH_TOKEN is this runner's own nwr_ credential.
set -euo pipefail

IMAGE="${NIGHTWATCH_IMAGE:-nightwatch/runner:latest}"
CONTAINER_NAME="nightwatch"
WS_URL="{{WS_URL}}"
NIGHTWATCH_TOKEN="{{NIGHTWATCH_TOKEN}}"
NIGHTWATCH_SERVER_NAME="{{NIGHTWATCH_SERVER_NAME}}"

echo "Pulling ${IMAGE}..."
docker pull "$IMAGE"

if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  echo "Stopping existing ${CONTAINER_NAME} container..."
  docker rm -f "$CONTAINER_NAME" >/dev/null
fi

# Read-only host access for evidence collection: the Docker socket, host /proc
# and /sys for metrics (iostat reads sysfs block stats), and the root filesystem
# for allowlisted file reads. No inbound ports - the runner dials out over WSS.
docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  --pid=host \
  --security-opt=no-new-privileges \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -v /proc:/host/proc:ro \
  -v /sys:/sys:ro \
  -v /:/rootfs:ro \
  -e "NIGHTWATCH_TOKEN=${NIGHTWATCH_TOKEN}" \
  -e "WS_URL=${WS_URL}" \
  -e "NIGHTWATCH_SERVER_NAME=${NIGHTWATCH_SERVER_NAME}" \
  -e "HOST_PROC=/host/proc" \
  "$IMAGE"

echo ""
echo "Nightwatch runner is running."
echo ""
echo "  Container: ${CONTAINER_NAME}"
echo "  Server:    ${NIGHTWATCH_SERVER_NAME}"
echo ""
echo "Logs: docker logs -f ${CONTAINER_NAME}"
