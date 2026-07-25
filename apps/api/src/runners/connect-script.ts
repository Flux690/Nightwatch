// Inlined, not read from disk: walking up from the module's own path breaks under
// bundling. Shell ${...} is escaped as \${...} to survive the template literal;
// {{...}} placeholders are substituted by GET /connect.sh.
export const CONNECT_SCRIPT_TEMPLATE = `#!/usr/bin/env bash
# NIGHTWARDEN_TOKEN is this runner's own nwr_ credential.
set -euo pipefail

IMAGE="\${NIGHTWARDEN_IMAGE:-nightwarden/runner:latest}"
CONTAINER_NAME="nightwarden"
WS_URL="{{WS_URL}}"
NIGHTWARDEN_TOKEN="{{NIGHTWARDEN_TOKEN}}"
NIGHTWARDEN_SERVER_NAME="{{NIGHTWARDEN_SERVER_NAME}}"

echo "Pulling \${IMAGE}..."
docker pull "$IMAGE"

if docker ps -a --format '{{.Names}}' | grep -q "^\${CONTAINER_NAME}$"; then
  echo "Stopping existing \${CONTAINER_NAME} container..."
  docker rm -f "$CONTAINER_NAME" >/dev/null
fi

# Read-only host access for evidence collection: the Docker socket, host /proc
# and /sys for metrics (iostat reads sysfs block stats), and the root filesystem
# for allowlisted file reads. No inbound ports - the runner dials out over WSS.
# --hostname passes the host's real name through, so the runner never
# advertises a container id as its hostname.
docker run -d \\
  --name "$CONTAINER_NAME" \\
  --restart unless-stopped \\
  --hostname "$(hostname)" \\
  --pid=host \\
  --security-opt=no-new-privileges \\
  -v /var/run/docker.sock:/var/run/docker.sock:ro \\
  -v /proc:/host/proc:ro \\
  -v /sys:/sys:ro \\
  -v /:/rootfs:ro \\
  -e "NIGHTWARDEN_TOKEN=\${NIGHTWARDEN_TOKEN}" \\
  -e "WS_URL=\${WS_URL}" \\
  -e "NIGHTWARDEN_SERVER_NAME=\${NIGHTWARDEN_SERVER_NAME}" \\
  -e "HOST_PROC=/host/proc" \\
  "$IMAGE"

echo ""
echo "NightWarden runner is running."
echo ""
echo "  Container: \${CONTAINER_NAME}"
echo "  Server:    \${NIGHTWARDEN_SERVER_NAME}"
echo ""
echo "Logs: docker logs -f \${CONTAINER_NAME}"
`;
