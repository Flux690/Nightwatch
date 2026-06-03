#!/usr/bin/env bash
# Nightwatch local smoke test — drives the full Phase 4 path against Clipper.
#
#   scripts/smoke.sh setup            env files, infra (Postgres/Redis), Clipper, db schema
#   scripts/smoke.sh up               start API + runner in the background
#   scripts/smoke.sh fire [ctr] [a]   POST a synthetic alert (default container "api")
#   scripts/smoke.sh logs             follow API + runner logs
#   scripts/smoke.sh status           containers + process state
#   scripts/smoke.sh down             stop API + runner
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
RUN_DIR=".smoke"
mkdir -p "$RUN_DIR"

setup() {
  # Don't clobber an existing .env (it holds your key).
  [ -f apps/api/.env ]    || { cp apps/api/.env.example apps/api/.env;       echo "created apps/api/.env — add your OpenRouter key to OPENAI_API_KEY"; }
  [ -f apps/runner/.env ] || { cp apps/runner/.env.example apps/runner/.env; echo "created apps/runner/.env"; }
  mkdir -p apps/runner/data
  echo "Bringing up Nightwatch infra (Postgres 5433 / Redis 6380)..."
  pnpm dev:infra
  echo "Bringing up Clipper (the test subject)..."
  ( cd clipper && docker compose up -d )
  echo "Applying database schema..."
  pnpm --filter @nightwatch/api exec prisma migrate dev --name init
  echo ""
  echo "Setup done. Put your OpenRouter key in apps/api/.env, then: scripts/smoke.sh up"
}

up() {
  mkdir -p apps/runner/data
  echo "Starting API (logs: $RUN_DIR/api.log)..."
  pnpm --filter @nightwatch/api dev > "$RUN_DIR/api.log" 2>&1 &
  echo $! > "$RUN_DIR/api.pid"
  sleep 3
  echo "Starting runner (logs: $RUN_DIR/runner.log)..."
  pnpm --filter @nightwatch/runner dev > "$RUN_DIR/runner.log" 2>&1 &
  echo $! > "$RUN_DIR/runner.pid"
  echo ""
  echo "Up. Break something (clipper/chaos.sh transcoder), then: scripts/smoke.sh fire transcoder"
}

fire() {
  local container="${1:-api}"
  local alertname="${2:-ContainerHighMemory}"
  local fp="smoke-$(date +%s)"
  local started; started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # fingerprint is unique per run so dedup (24h) doesn't drop repeat fires.
  local payload
  payload=$(cat <<JSON
{
  "alerts": [
    {
      "labels": { "alertname": "$alertname", "container": "$container", "severity": "critical" },
      "annotations": { "summary": "$alertname on $container (smoke test)" },
      "startsAt": "$started",
      "fingerprint": "$fp",
      "status": "firing"
    }
  ]
}
JSON
)
  echo "Firing: container=$container alert=$alertname fingerprint=$fp"
  curl -sS -X POST "http://localhost:${PORT:-3000}/alerts/ingest" \
    -H "Content-Type: application/json" \
    -H "X-Installation-Id: ${INSTALLATION:-inst_local}" \
    -d "$payload"
  echo ""
  echo "Watch: scripts/smoke.sh logs"
}

logs() { tail -n 40 -f "$RUN_DIR/api.log" "$RUN_DIR/runner.log"; }

status() {
  docker ps --format "table {{.Names}}\t{{.Status}}"
  echo ""
  for svc in api runner; do
    if [ -f "$RUN_DIR/$svc.pid" ] && kill -0 "$(cat "$RUN_DIR/$svc.pid")" 2>/dev/null; then
      echo "$svc: running (pid $(cat "$RUN_DIR/$svc.pid"))"
    else
      echo "$svc: stopped"
    fi
  done
}

down() {
  for svc in runner api; do
    if [ -f "$RUN_DIR/$svc.pid" ]; then
      kill "$(cat "$RUN_DIR/$svc.pid")" 2>/dev/null && echo "stopped $svc" || true
      rm -f "$RUN_DIR/$svc.pid"
    fi
  done
  echo "API + runner stopped. Infra + Clipper still up (docker compose down to stop them)."
}

case "${1:-help}" in
  setup)  setup ;;
  up)     up ;;
  fire)   shift; fire "$@" ;;
  logs)   logs ;;
  status) status ;;
  down)   down ;;
  *) echo "usage: scripts/smoke.sh {setup|up|fire [container] [alertname]|logs|status|down}" ;;
esac
