# Nightwatch v2 — Phase Reference

> Static reference document. Not a task tracker — use TodoWrite for in-session tracking, git log for history.

## Current Phase: 4 — End-to-End Investigation

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

### Phase 4 — End-to-End Investigation (read-only walking skeleton)

**Part A — LLM provider layer (extract to `apps/api/src/llm/`)**
- [ ] Move LLMProvider port + ToolSchema/ToolUse/ToolResult/ChatResponse → llm/provider.ts
- [ ] llm/anthropic.ts: AnthropicProvider, env-driven (ANTHROPIC_API_KEY, ANTHROPIC_MODEL)
- [ ] llm/openai.ts: OpenAIProvider via openai SDK (OpenAI-compatible → OpenRouter free models)
- [ ] llm/factory.ts: createProvider() selects adapter by LLM_PROVIDER; both always compiled in
- [ ] loop.ts uses createProvider() instead of `new AnthropicProvider()`

**Part B — Close the path + smoke test**
- [ ] write_incident runner command (dispatch → existing insertIncident) + matching shared ws.ts type
- [ ] conclude() persists IncidentRecord via sendCommand("write_incident", ...)
- [ ] Runner local harness: run via tsx against host Docker socket + local API
- [ ] .http smoke: curl /alerts/ingest → BullMQ → loop → LLM → runner read tool → conclude → SQLite
- [ ] prisma migrate dev (ApprovalRequest table already in schema)

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
