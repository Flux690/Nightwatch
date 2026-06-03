# Nightwatch v2 — Phase Reference

> Static reference document. Not a task tracker — use TodoWrite for in-session tracking, git log for history.

## Current Phase: 5a — Approval Cycle (Phase 4 ✅ complete; Phase 4.5 deployment packaging deferred/parallel)

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

### Phase 4.5 — Deployment Packaging (runner container + install) [deferred, parallelizable]
- [ ] Runner Dockerfile (Linux image) — the production form of the runner
- [ ] Install script: inject the runner into a target compose with Docker-socket mount + NIGHTWATCH_TOKEN/WS_URL
- [ ] Bundle Prometheus + Alertmanager so alerts fire via the real POST /alerts/ingest webhook (identical contract to `scripts/smoke.sh fire` — no API change needed)
- [ ] Verify host introspection tools work once the runner is a Linux container
- Note: does NOT block 5a/5b (those run against the tsx runner). Required before real deployments and before host-tool testing is meaningful.

### Phase 5a — Approval Cycle (curl/.http-testable, no external deps)
- [ ] REST POST /incidents/:id/approve|reject → resolveApproval() (the missing return path)
- [ ] .http: write tool → approval pending → approve → runner executes → result → conclude
- [ ] Minimal approval page in console (plain fetch, no TanStack yet — embryo of Phase 6)

### Phase 5b — Slack Approval (over the proven 5a backbone)
- [ ] notifications/slack.ts: approval card with Approve/Reject/Add Context
- [ ] Slack interaction webhook → same resolveApproval()
- [ ] Capstone: PRD section 5.3 synthetic first-run test

### Phase 6 — Console (full)
- [ ] Vite + React 19 scaffold
- [ ] TanStack Router: file-based routes
- [ ] TanStack Query: REST to API
- [ ] WebSocket hook: real-time incident feed
- [ ] Promote the 5a approval page into the real Approvals route

### Phase 7 — Hardening
- [ ] SQLite history loaded into initial investigation context
- [ ] Reconnection resilience (exponential backoff both sides)
- [ ] Error handling: all 6 failure modes from PRD section 19
- [ ] Rate limiting dashboard indicator

## Architecture Decisions
- Full spec: PRD.md
- Tool definitions: PRD section 8
- Tech stack: PRD section 18.1
- Approval flow: PRD sections 6.5, 9.3, 13.2
- Session continuity: PRD section 10.6
- LLM inference: hand-rolled ports-and-adapters in `apps/api/src/llm` (Anthropic + OpenAI-compatible), no framework. Both adapters compiled in, selected by LLM_PROVIDER. PRD section 14.
