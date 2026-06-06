# Nightwatch v2 — Phase Reference

> Static reference document. Not a task tracker — use TodoWrite for in-session tracking, git log for history.

## Current Phase: 6 — Console (full). Phases 1 through 5.5 ✅ complete; 6 queued next.

### Phase 1 — Harness + Scaffold ✅ complete (commit 272f80c)
- [x] Git: tag v1.0.0, create v2 branch
- [x] PRD.md committed to v2
- [x] Fix .gitignore (.claude/ now committed)
- [x] CLAUDE.md, .claude/settings.json, hook scripts, rules files
- [x] PLAN.md (this file)
- [x] pnpm workspace init + tsconfig.base.json + root package.json
- [x] packages/shared — all TypeScript types (alerts, tools, approvals, ws, runner)
- [x] docker-compose.dev.yaml (Redis 7 alpine + Postgres 16 alpine)
- [x] Stub package.json + tsconfig.json for apps/runner, apps/api, apps/console

### Phase 2 — Runner ✅ complete (commit fe8ab28)
- [x] WebSocket outbound connection to API (ws library)
- [x] Capability manifest: detect Docker, containers, Prometheus
- [x] Command dispatch table + unknown-command handler
- [x] commands/container.ts: logs, inspect, stats, events, processes, list
- [x] commands/host.ts: memory, cpu, disk, network, dmesg
- [x] commands/code.ts: commits, deploys, env_var_names, read_file
- [x] commands/remediation.ts: restart, rollback, exec (REMEDIATION_ENABLED gate)
- [x] sqlite/history.ts: incident read/write (better-sqlite3)

### Phase 3 — API ✅ complete (commit 2c0bff7)
- [x] Fastify server entry + @fastify/websocket plugin
- [x] ws/server.ts: runner connection registry, capability manifest store
- [x] ws/router.ts: sendCommand → Promise map keyed by correlationId
- [x] alerts/ingest.ts: POST /alerts/ingest, normalization, parsers
- [x] alerts/dedup.ts: sourceAlertId deduplication (Redis NX, 24h TTL)
- [x] alerts/queue.ts: BullMQ queue, rate limiting (10/hr), 90s debounce
- [x] investigation/tools.ts: 21 Anthropic TOOL_SCHEMAS
- [x] investigation/context.ts: assemble initial LLM context
- [x] investigation/loop.ts: agentic while loop, approval gate, Zod result validation
- [x] jobs/worker.ts: BullMQ worker, concurrency 5

### Phase 4 — End-to-End Investigation (read-only walking skeleton) ✅ complete

**Part A — LLM provider layer (`apps/api/src/llm/`)** ✅ (commits c34eebb, b3d55f7)
- [x] LLMProvider port + ToolSchema/ToolUse/ToolResult/ChatResponse → llm/provider.ts
- [x] llm/anthropic.ts: AnthropicProvider, env-driven (ANTHROPIC_API_KEY, ANTHROPIC_MODEL)
- [x] llm/openai.ts: OpenAIProvider via openai SDK (OpenAI-compatible → OpenRouter free models)
- [x] llm/factory.ts: createProvider() selects adapter by LLM_PROVIDER; both always compiled in
- [x] loop.ts uses createProvider() instead of `new AnthropicProvider()`

**Part B — Close the path + smoke test** ✅ (commits b3d55f7, 89b995f, 5289948, a46b357)
- [x] write_incident runner command (dispatch → existing insertIncident) + matching shared ws.ts type
- [x] conclude() persists IncidentRecord via sendCommand("write_incident", ...)
- [x] Runner local harness: run via tsx against host Docker socket + local API (scripts/smoke.sh)
- [x] End-to-end proven: alert → BullMQ → loop → OpenRouter → runner read tools → conclude → SQLite row. (Planned .http replaced by scripts/smoke.sh + clipper/chaos.sh fault injection.)
- [x] prisma migrate dev — init migration committed
- [x] Observability (added after first smoke run hung): pino structured logging across loop/providers; bounded LLM request timeout + maxRetries so a free-model 503/429 surfaces instead of hanging

**Smoke-test findings — address in later phases:**
- Test fidelity: the synthetic alert type must match the injected fault. Firing `ContainerHighMemory` while chaos does `docker stop` yielded a confabulated "memory leak" at 0.85 confidence with no memory evidence. → fix smoke defaults / chaos→alert mapping.
- Confidence guardrail: when key evidence can't be gathered, the prompt should lower confidence and reconcile the alert against actual container state instead of trusting the label. → Phase 7 (prompt hardening).
- Host tools (/proc, dmesg, cgroup reads) only work when the runner runs as a Linux container; they fail with the runner on a macOS host. → resolved by Phase 4.5.

### Phase 4.5 — Deployment Packaging (single container + self-detecting install) ✅ complete

**Architecture decision:** One container bundles runner + Prometheus + Alertmanager + cAdvisor. s6-overlay supervises all four processes. The install script auto-detects what the user already has and skips bundled services accordingly. Env var convention follows industry standard: `PROMETHEUS_URL` / `ALERTMANAGER_URL` — presence means "use mine", absence means "start bundled". No flags, no modes.

**Prerequisites** ✅
- [x] Pino structured logger added to runner (replaced all console.log/console.error)
- [x] HOST_PROC parameterization in host.ts for containerized /proc access

**4.5a — Single container image** ✅
- [x] Dockerfile: multi-stage build on node:24-slim (glibc needed for better-sqlite3 + monitoring binaries)
- [x] s6-overlay v3 service scripts: conditionally start Prometheus/Alertmanager based on env vars
- [x] cAdvisor always runs (feeds container metrics regardless of who consumes them)
- [x] Bundled Prometheus config: scrape cAdvisor at localhost:8080, evaluate alert rules
- [x] Bundled Alertmanager config: webhook to the API `POST /alerts/ingest?token=${NIGHTWATCH_TOKEN}`
- [x] Default `rules.yml`: memory >85% 5m, CPU >90% 5m, restart count >3 in 15m, disk >90%, container down >1m
- [x] Runner mounts: `/var/run/docker.sock` (ro), `/proc` (ro), `nightwatch-data` volume at `/var/nightwatch`
- [x] Docker build verified: `pnpm deploy` works without `--legacy` via `injectWorkspacePackages: true` in pnpm-workspace.yaml

**4.5b — install.sh (self-detecting, one script)** ✅
- [x] Single script at `install/install.sh`
- [x] Auto-detect: check `docker ps` + probe ports for existing Prometheus (9090) and Alertmanager (9093)
- [x] If detected: set env vars on the container, print webhook snippet for user's existing Alertmanager
- [x] If not detected: leave env vars unset, bundled services start automatically
- [x] Always: pull image, `docker run` with socket mount + token + WS URL
- [x] Output: clear summary of what was detected/started

**4.5c — Dev environment** ✅
- [x] Add cAdvisor + Prometheus + Alertmanager to `docker-compose.dev.yaml`
- [x] Same `rules.yml` and configs shared between dev compose and production container
- [x] smoke.sh updated (X-Nightwatch-Token header, token query param)

**Dependency upgrades (done alongside 4.5):**
- [x] All packages pinned to exact latest stable versions (no carets)
- [x] pnpm v11.5.1 via corepack `packageManager` field
- [x] `injectWorkspacePackages: true` in pnpm-workspace.yaml (proper pnpm v11 config, replaces .npmrc)
- [x] Zod 3.23 → 4.4.3 (fixed `z.record()` to require key + value schemas)
- [x] TypeScript 5.5 → 6.0.3, React 19.0 → 19.2.7, Vite 5.3 → 8.0.16, Fastify 5.8.5, etc.
- [x] Prisma 5.16 → 6.19.3 (latest compatible with current schema)
- [x] PRD.md updated for drift (base image, container architecture, install structure)
- [x] Comment cleanup enforced across all file types (Dockerfile, .sh, .ts, .yaml)

**Alert identity cleanup (done alongside 4.5):**
- [x] API ingest accepts `X-Nightwatch-Token` header and `?token=` query param
- [x] Alertmanager configs use `?token=` query param (Alertmanager does not support custom HTTP headers)
- [x] `installationId` → `token` rename throughout the codebase (5 shared types, 10 API files, 2 runner files, Prisma schema, PRD.md). Decision: identify installations by `token` directly, no separate `installationId`. The `ApprovalRequest` table was dropped (approval flow is an in-memory EventEmitter, not a DB row). WS connect verifies `token` against the `Installation` table.

**Deferred from 4.5:**
- Prisma 7 migration: v7 removes `datasource.url` from schema, requires a new `prisma.config.ts`, and changes client imports. Staying on 6.19.3 until a dedicated migration task.
- Host introspection verification (/proc, dmesg, cgroup reads inside running container): Docker image builds, but live container test against clipper pending.
- Real Prometheus alert flow in dev: monitoring stack is in docker-compose.dev.yaml, but the metrics-driven end-to-end flow (chaos fault → cAdvisor → Prometheus rule fires → Alertmanager webhook → API ingest) cannot be tested live on Docker Desktop for Mac. cAdvisor there only emits the root cgroup (`container_last_seen{id="/"}`) and zero `name`-labeled per-container series, because containers run inside the LinuxKit VM and cAdvisor can't read per-container cgroup accounting (cgroup v2 + VM layout). Since every rule in `rules.yml` filters on `{name!=""}`, no rule can fire locally. Confirmed not fixable via cAdvisor config (tried `privileged`, `/:/rootfs:ro`, `/var/run` mounts). The path from `/alerts/ingest` onward is fully proven via `scripts/smoke.sh fire` (manual webhook, exercised end-to-end incl. the approval cycle in Phase 5.5). The real metrics path must be validated on a Linux host / CI where cAdvisor reads host cgroups natively.

### Phase 5 — Approval Cycle + Investigation Completeness ✅ complete
- [x] REST POST /incidents/:id/approve|reject → resolveApproval() (the missing return path)
- [x] Unified session scaffolding: one loop/one system prompt, alert authors the opening user message (groundwork for chat in Phase 6)
- [x] Runner identity: stable `runnerId` persisted in the SQLite volume; API connection registry keyed by `(token, runnerId)` so multiple runners per token don't overwrite each other
- [x] SQLite incident history injected into initial investigation context (same container + same alertType, collapse repeats, cap ~5, labeled plain text)
- [x] Approval-deadline pause: hard timer stops while an approval is pending (human wait time doesn't abort the run)
- [x] smoke.sh approval helpers (pending/approve/reject) driving the full cycle: write tool → approval pending → approve → runner executes → result → conclude
- [x] Minimal approval page in console (plain fetch, no TanStack yet — embryo of Phase 6)
- [x] Faster default detection: cAdvisor housekeeping 15s->5s, Prometheus scrape/eval 15s->5s, `ContainerDown` `last_seen>15`/`for:10s`, Alertmanager `group_wait` 30s->5s (~3min -> ~30s for the down signal; resource rules keep their `for:5m`)
- [ ] (future) User-overridable alert rules: `configure.sh` currently `cp`s our `rules.yml` over the user's on every boot. Should prefer a mounted `rules.yml` / `rules.d/` if present and fall back to our defaults - the standard Prometheus rule-file convention, so users tune thresholds without forking. Not done; deferred.

### Phase 5.5 — Agentic LLM Hardening ✅ complete
The live Phase 5 test ran the loop on under-powered defaults: the model recommended a write tool in free-text JSON and concluded instead of invoking it, so the approval cycle never fired. This subphase makes both providers proper agentic clients and replaces text-scraping with a schema-guaranteed conclusion. Proven end-to-end after this change: the model invoked `restart_container` → approval pending → approved → runner executed → `conclude`.
- [x] Shared `llm/config.ts`: `MAX_OUTPUT_TOKENS = 32000` (was 4096) plus the consolidated `REQUEST_TIMEOUT_MS` / `MAX_RETRIES` (deduped from both providers)
- [x] Streaming on both providers (`messages.stream().finalMessage()` / `chat.completions.stream().finalChatCompletion()`) so 32K output can't trip the single-read timeout
- [x] AnthropicProvider: prompt caching (cache_control on system block + rolling message breakpoint), adaptive thinking, proper stop_reason mapping (add `refusal`)
- [x] OpenAIProvider parity: strict function calling, `content_filter` → refusal
- [x] `conclude` strict tool (terminal, schema = InvestigationResult); `strict?` added to ToolSchema
- [x] Loop handles conclude tool_use (zod-validate → conclude), refusal/no-conclude → escalate
- [x] Remove the regex/JSON.parse hack in result.ts; conclude() takes the validated object
- [x] Rip out `confidence` everywhere (result.ts schema+log, context.ts prompt+template, shared incidents.ts)
- [x] System prompt rewrite: call the gated tool, do not describe it; finish by calling conclude

### Phase 6 — Console (full)
- [ ] Vite + React 19 scaffold
- [ ] TanStack Router: file-based routes
- [ ] TanStack Query: REST to API
- [ ] WebSocket hook: real-time session feed
- [ ] Single unified session feed: investigations and chat in one surface (promote the Phase 5 approval page into the real Approvals route)
- [ ] Chat: human-triggered entry into the same loop (write tools still gated by approval)
- [ ] Runner online/offline indicator (heartbeat every 30s, ~60s silence = offline)
- [ ] `GET /clients/config` endpoint feeding the loop (replaces hardcoded MAX_TOOL_CALLS / timeouts)
- [ ] Session transcript persistence: `sessions` + `session_messages` tables on the runner, API appends per turn via `append_session_message` WS command
- [ ] Settings page: alert rule configuration (thresholds per installation)
- [ ] Mechanism: API stores updated rules, sends `update_alert_rules` command to runner via WebSocket, runner rewrites Prometheus `rules.yml` and hits `/-/reload`

### Phase 7 — Resilience & Reliability
- [ ] Reconnection resilience (exponential backoff, both runner→API and console→API)
- [ ] Error handling: all 6 failure modes from PRD section 19
- [ ] Prompt hardening: evidence-grounding guardrail (escalate rather than act on thin evidence). Note: the original Phase 4 "confidence guardrail" framing is obsolete - `confidence` was removed in Phase 5.5; the guardrail is now behavioral (the system prompt's escalation policy), not a self-reported number.
- [ ] First-run synthetic test (validates the end-to-end flow before a real incident)
- [ ] Rate limiting indicator in the console
- [ ] Full self-hosted `docker compose` stack (API + console + Postgres + Redis alongside the runner)

### Phase 8 — Integrations
- [ ] Slack: investigation results + Approve/Reject buttons (makes the approval flow usable off the console)
- [ ] GitHub: `get_recent_commits` / deploy correlation against real repos
- [ ] OAuth credential storage (encrypted), per-installation integration config

### Phase 9 — Multi-runtime / Kubernetes
- [ ] Runner command implementations for Kubernetes (kubectl instead of docker): pods, deployments, namespaces
- [ ] Capability manifest extends to detect Kubernetes
- [ ] `scale_container` remediation tool (K8s-only) wired through the approval gate

### Phase 10 — Proactive Detection
- [ ] Metric snapshot collection: runner queries local Prometheus every 5min via PromQL, sends snapshots to the API
- [ ] Rolling telemetry context: API stores snapshots in Redis with 2-hour TTL
- [ ] Trend evaluation: API detects patterns (memory trending to OOM, disk filling, restart loops) and fires self-generated alerts
- [ ] Proactive alerts flow through the same investigation pipeline as reactive alerts (same loop, same tools, richer starting context)

## Architecture Decisions
- Full spec: PRD.md
- Tool definitions: PRD section 8
- Tech stack: PRD section 18.1
- Approval flow: in-memory EventEmitter (no DB table), keyed by `tool_use_id`; 4-min approval timeout, 90s clarification timeout. The gate set is `REQUIRES_APPROVAL` in `apps/api/src/investigation/tools.ts`. PRD sections 6.5, 9.3, 13.2
- **Unified session model:** one agentic loop, one system prompt, two triggers. An alert authors the opening user message; a chat message is the human-triggered entry into the same loop. A concluded investigation stays open as a session the user can continue. PRD section 9.0, 16
- **Sessions & memory:** episodic `IncidentRecord`s (implemented) injected at run start; full transcript persisted on the runner (`sessions` + `session_messages`, planned), appended per turn. No status machine, no TTL, no auto-prune — user-deletable. No vector DB, no cross-installation learning, no hardcoded pattern library. PRD section 10.6
- **API-stateless / runner-is-system-of-record:** the API holds the message array only in worker memory during a run; all durable user data lives on the runner. PRD sections 4.3, 10.4
- **Runner identity:** stable `runnerId` per runner instance (persisted UUID in the SQLite volume); API registry keyed by `(token, runnerId)`. PRD section 7.2
- LLM inference: hand-rolled ports-and-adapters in `apps/api/src/llm` (Anthropic + OpenAI-compatible), no framework. Both adapters compiled in, selected by LLM_PROVIDER. PRD section 14.
- **Single container:** runner + Prometheus + Alertmanager + cAdvisor in one Docker image, s6-overlay process supervisor. User sees one container in `docker ps`. PRD's 5-container install table collapsed into one image for simplicity.
- **Self-detecting install:** one `install.sh` script, no flags. Auto-detects existing Prometheus/Alertmanager via `docker ps` + port probes. Sets `PROMETHEUS_URL` / `ALERTMANAGER_URL` env vars if found (industry-standard convention: presence = BYO, absence = bundled). Prints webhook snippet if user has existing Alertmanager.
- **Reactive-first:** proactive detection (metric snapshots, rolling telemetry, trend evaluation) deferred to Phase 10. Phases 5-7 focus on the reactive path: alert fires → investigate → recommend/remediate. Integrations (Phase 8) and Kubernetes (Phase 9) come before proactive detection.
