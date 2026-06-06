#!/usr/bin/env bash
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
  echo "Bringing up Nightwatch infra (Postgres/Redis + Prometheus/Alertmanager/cAdvisor)..."
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
  echo "Starting console (logs: $RUN_DIR/console.log)..."
  pnpm --filter @nightwatch/console dev > "$RUN_DIR/console.log" 2>&1 &
  echo $! > "$RUN_DIR/console.pid"
  echo ""
  echo "Up. Approval console: http://localhost:5173"
  echo ""
  echo "Drive the full approval cycle:"
  echo "  1. Trigger:  scripts/smoke.sh fire clipper-redis ContainerRestarting"
  echo "               (or real: clipper/chaos.sh oom, wait ~5min for the alert)"
  echo "  2. Watch:    scripts/smoke.sh logs   (until you see 'approval pending')"
  echo "  3. Resolve:  approve/reject in the console UI, or from the terminal:"
  echo "               scripts/smoke.sh pending"
  echo "               scripts/smoke.sh approve <incidentId>"
  echo ""
  echo "Check monitoring: scripts/smoke.sh stack"
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
    -H "X-Nightwatch-Token: ${INSTALLATION:-inst_local}" \
    -d "$payload"
  echo ""
  echo "Watch: scripts/smoke.sh logs"
}

pending() {
  curl -sS "http://localhost:${PORT:-3000}/incidents/pending" \
    -H "X-Nightwatch-Token: ${INSTALLATION:-inst_local}"
  echo ""
}

approve() {
  local id="${1:?usage: scripts/smoke.sh approve <incidentId>}"
  curl -sS -X POST "http://localhost:${PORT:-3000}/incidents/${id}/approve" \
    -H "Content-Type: application/json" \
    -H "X-Nightwatch-Token: ${INSTALLATION:-inst_local}" \
    -d '{"resolvedBy":"smoke.sh"}'
  echo ""
}

reject() {
  local id="${1:?usage: scripts/smoke.sh reject <incidentId>}"
  curl -sS -X POST "http://localhost:${PORT:-3000}/incidents/${id}/reject" \
    -H "Content-Type: application/json" \
    -H "X-Nightwatch-Token: ${INSTALLATION:-inst_local}" \
    -d '{"resolvedBy":"smoke.sh","comment":"rejected via smoke"}'
  echo ""
}

stack() {
  local ok=0 fail=0
  echo "Monitoring stack health:"
  echo ""

  if curl -sf --max-time 2 "http://localhost:8080/healthz" >/dev/null 2>&1; then
    echo "  cAdvisor:     http://localhost:8080  OK"
    ((ok++))
  else
    echo "  cAdvisor:     http://localhost:8080  UNREACHABLE"
    ((fail++))
  fi

  if curl -sf --max-time 2 "http://localhost:9090/-/healthy" >/dev/null 2>&1; then
    echo "  Prometheus:   http://localhost:9090  OK"
    ((ok++))
    local targets
    targets=$(curl -sf "http://localhost:9090/api/v1/targets" 2>/dev/null)
    if [ -n "$targets" ]; then
      local up_count
      up_count=$(echo "$targets" | grep -o '"health":"up"' | wc -l | tr -d ' ')
      echo "                scrape targets up: $up_count"
    fi
  else
    echo "  Prometheus:   http://localhost:9090  UNREACHABLE"
    ((fail++))
  fi

  if curl -sf --max-time 2 "http://localhost:9093/-/healthy" >/dev/null 2>&1; then
    echo "  Alertmanager: http://localhost:9093  OK"
    ((ok++))
  else
    echo "  Alertmanager: http://localhost:9093  UNREACHABLE"
    ((fail++))
  fi

  echo ""
  if [ "$fail" -eq 0 ]; then
    echo "All $ok services healthy. Real alerts will flow to POST /alerts/ingest."
  else
    echo "$fail service(s) down. Run: pnpm dev:infra"
  fi
}

logs() { tail -n 40 -f "$RUN_DIR/api.log" "$RUN_DIR/runner.log"; }

status() {
  docker ps --format "table {{.Names}}\t{{.Status}}"
  echo ""
  for svc in api runner console; do
    if [ -f "$RUN_DIR/$svc.pid" ] && kill -0 "$(cat "$RUN_DIR/$svc.pid")" 2>/dev/null; then
      echo "$svc: running (pid $(cat "$RUN_DIR/$svc.pid"))"
    else
      echo "$svc: stopped"
    fi
  done
}

down() {
  for svc in console runner api; do
    if [ -f "$RUN_DIR/$svc.pid" ]; then
      kill "$(cat "$RUN_DIR/$svc.pid")" 2>/dev/null && echo "stopped $svc" || true
      rm -f "$RUN_DIR/$svc.pid"
    fi
  done
  echo "API + runner + console stopped. Infra + Clipper still up (docker compose down to stop them)."
}

case "${1:-help}" in
  setup)   setup ;;
  up)      up ;;
  fire)    shift; fire "$@" ;;
  pending) pending ;;
  approve) shift; approve "$@" ;;
  reject)  shift; reject "$@" ;;
  stack)   stack ;;
  logs)    logs ;;
  status)  status ;;
  down)    down ;;
  *) echo "usage: scripts/smoke.sh {setup|up|fire [container] [alertname]|pending|approve <id>|reject <id>|stack|logs|status|down}" ;;
esac
