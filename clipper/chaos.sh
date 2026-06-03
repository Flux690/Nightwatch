#!/usr/bin/env bash
# Clipper Chaos Utility — trigger failure scenarios for testing Nightwatch.
# Usage: ./chaos.sh <scenario>
set -uo pipefail

NETWORK="clipper_default"

ok()     { printf '\033[32m[OK]\033[0m %s\n' "$1"; }
fail()   { printf '\033[31m[X]\033[0m %s\n' "$1"; }
info()   { printf '\033[33m%s\033[0m : %s\n' "$1" "$2"; }
header() { printf '\n\033[33m=== %s ===\033[0m\n\n' "$1"; }

stop_fast() {
  local running=()
  for c in "$@"; do
    [ -n "$(docker ps -q -f "name=^${c}$")" ] && running+=("$c")
  done
  if [ "${#running[@]}" -gt 0 ]; then
    docker stop --time 1 "${running[@]}" >/dev/null 2>&1
    ok "Stopped: ${running[*]}"
  else
    fail "None running: $*"
  fi
}

start_containers() {
  for c in "$@"; do
    if [ -n "$(docker ps -aq -f "name=^${c}$")" ]; then
      docker start "$c" >/dev/null 2>&1 && ok "Started $c"
    else
      fail "$c does not exist"
    fi
  done
}

show_help() {
  cat <<'EOF'
Clipper Chaos Utility

Usage: ./chaos.sh <scenario>

Basic Scenarios (restart fixes):
  cache        Stop Redis (immediate detection, 3-node cascade)
  db           Stop PostgreSQL (needs interaction)
  storage      Stop S3 storage (needs interaction)
  transcoder   Stop transcoder worker
  notifier     Stop notifier worker
  pipeline     Stop cache + storage (5-node cascade)
  infra        Stop db + cache + storage (6-node cascade)

Advanced Scenarios (requires docker exec or config change):
  oom          Redis OOM - rejects writes (needs user knowledge)
  maxclients   Redis connection limit - rejects connections (immediate)
  network      Disconnect API from network (immediate, needs reconnect)

Utility:
  restore      Start all containers + reset all configs
  status       Show container status
EOF
}

case "$(echo "${1:-help}" | tr '[:upper:]' '[:lower:]')" in
  cache)
    header "Scenario: Cache Failure"
    stop_fast cache
    info "Detection" "Immediate (workers poll Redis)"
    info "Cascade" "cache -> transcoder, notifier (3 nodes)"
    info "Fix" "docker start cache"
    ;;
  db)
    header "Scenario: Database Failure"
    stop_fast db
    info "Detection" "On interaction (upload/list videos)"
    info "Cascade" "db -> api (2 nodes)"
    info "Fix" "docker start db"
    ;;
  storage)
    header "Scenario: Storage Failure"
    stop_fast storage
    info "Detection" "On interaction (upload a video)"
    info "Cascade" "storage -> api (2 nodes)"
    info "Fix" "docker start storage"
    ;;
  transcoder)
    header "Scenario: Transcoder Failure"
    stop_fast transcoder
    info "Detection" "Videos stay 'pending' indefinitely"
    info "Fix" "docker start transcoder"
    ;;
  notifier)
    header "Scenario: Notifier Failure"
    stop_fast notifier
    info "Detection" "No email notifications sent"
    info "Fix" "docker start notifier"
    ;;
  pipeline)
    header "Scenario: Pipeline Block (cache + storage)"
    stop_fast cache storage
    info "Detection" "Immediate (cache) + on interaction (storage)"
    info "Cascade" "cache + storage -> api, transcoder, notifier (5 nodes)"
    info "Fix" "docker start cache storage"
    ;;
  infra)
    header "Scenario: Total Infrastructure Failure"
    stop_fast db cache storage
    info "Detection" "Immediate (all failures in single batch)"
    info "Cascade" "db + cache + storage -> api, transcoder, notifier (6 nodes)"
    info "Fix" "docker start db cache storage"
    ;;
  oom)
    header "Scenario: Redis OOM (running but full)"
    docker exec cache redis-cli CONFIG SET maxmemory 1mb >/dev/null
    ok "Set maxmemory to 1mb"
    docker exec cache redis-cli CONFIG SET maxmemory-policy noeviction >/dev/null
    ok "Set maxmemory-policy to noeviction"
    echo "Filling Redis with data..."
    padding=$(printf 'X%.0s' $(seq 1 1024))
    filled=false
    for i in $(seq 0 1999); do
      if docker exec cache redis-cli SET "fill:$i" "$padding" 2>&1 | grep -q "OOM"; then
        ok "Redis is full after $i keys"; filled=true; break
      fi
    done
    [ "$filled" = false ] && ok "Filled 2000 keys into Redis"
    info "Detection" "On next write (upload a video)"
    info "Fix" "docker exec cache redis-cli CONFIG SET maxmemory 0"
    info "Note" "Requires user knowledge (maxmemory value)"
    ;;
  maxclients)
    header "Scenario: Redis Connection Limit (running but rejecting)"
    docker exec cache redis-cli CONFIG SET maxclients 1 >/dev/null
    ok "Set maxclients to 1"
    info "Detection" "Immediate (workers can't connect)"
    info "Fix" "docker exec cache redis-cli CONFIG SET maxclients 10000"
    info "Note" "Container is UP - restart won't help without config fix"
    ;;
  network)
    header "Scenario: Network Partition (API isolated)"
    if docker network disconnect "$NETWORK" api 2>/dev/null; then
      ok "API disconnected from $NETWORK network"
    else
      fail "Failed to disconnect (may already be disconnected)"
    fi
    info "Detection" "Immediate (API can't reach cache/db/storage)"
    info "Fix" "docker network connect $NETWORK api"
    info "Note" "Container is UP - restart alone won't fix"
    ;;
  restore)
    header "Restoring All Containers"
    if [ -n "$(docker ps -q -f 'name=^cache$')" ]; then
      docker exec cache redis-cli CONFIG SET maxmemory 0 >/dev/null 2>&1 || true
      docker exec cache redis-cli CONFIG SET maxmemory-policy noeviction >/dev/null 2>&1 || true
      docker exec cache redis-cli CONFIG SET maxclients 10000 >/dev/null 2>&1 || true
      docker exec cache redis-cli FLUSHALL >/dev/null 2>&1 || true
      ok "Redis config reset and data flushed"
    fi
    docker network connect "$NETWORK" api 2>/dev/null && ok "API reconnected to network" || true
    start_containers db cache storage
    sleep 2
    docker exec cache redis-cli CONFIG SET maxmemory 0 >/dev/null 2>&1 || true
    docker exec cache redis-cli CONFIG SET maxclients 10000 >/dev/null 2>&1 || true
    docker exec cache redis-cli FLUSHALL >/dev/null 2>&1 || true
    ok "Redis config reset and data flushed"
    docker restart transcoder notifier >/dev/null 2>&1 || true
    ok "Workers restarted (transcoder, notifier)"
    docker exec storage awslocal s3 mb s3://clipper-videos >/dev/null 2>&1 || true
    ok "S3 bucket ready"
    ;;
  status)
    header "Container Status"
    docker ps -a --format "table {{.Names}}\t{{.Status}}" | grep -E "NAMES|db|cache|storage|mailhog|api|transcoder|notifier|frontend"
    ;;
  *)
    show_help
    ;;
esac
