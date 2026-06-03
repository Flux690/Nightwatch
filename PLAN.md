# Nightwatch v2 — Phase Reference

> Static reference document. Not a task tracker — use TodoWrite for in-session tracking, git log for history.

## Current Phase: 1 — Harness + Scaffold (complete after this commit)

### Phase 1 Tasks
- [x] Git: tag v1.0.0, create v2 branch
- [x] PRD.md committed to v2
- [x] Fix .gitignore (.claude/ now committed)
- [x] CLAUDE.md, .claude/settings.json, hook scripts, rules files
- [x] PLAN.md (this file)
- [x] pnpm workspace init + tsconfig.base.json + root package.json
- [x] packages/shared — all TypeScript types (alerts, tools, approvals, ws, runner)
- [x] docker-compose.dev.yml (Redis 7 alpine + Postgres 16 alpine)
- [x] Stub package.json + tsconfig.json for apps/runner, apps/api, apps/console

### Phase 2 — Runner (parallel with Phase 3)
- [ ] WebSocket outbound connection to API (ws library)
- [ ] Capability manifest: detect Docker, containers, Prometheus
- [ ] Command dispatch table + unknown-command handler
- [ ] commands/container.ts: logs, inspect, stats, events, processes, list
- [ ] commands/host.ts: memory, cpu, disk, network, dmesg
- [ ] commands/code.ts: commits, deploys, env_var_names, read_file
- [ ] commands/remediation.ts: restart, rollback, exec (forwarded post-approval)
- [ ] sqlite/history.ts: incident read/write (better-sqlite3)

### Phase 3 — API (parallel with Phase 2)
- [ ] Fastify server entry + @fastify/websocket plugin
- [ ] ws/server.ts: runner connection registry, capability manifest store
- [ ] ws/router.ts: resolve which runner handles a given tool call
- [ ] alerts/ingest.ts: POST /alerts/ingest, normalization, parsers
- [ ] alerts/dedup.ts: sourceAlertId deduplication
- [ ] alerts/queue.ts: BullMQ queue, rate limiting (10/hr), debounce window
- [ ] investigation/tools.ts: Anthropic TOOL_SCHEMAS for all read tools
- [ ] investigation/context.ts: assemble initial LLM context
- [ ] investigation/loop.ts: main agentic while loop (read tools only first)
- [ ] Tool routing: Promise map keyed by tool_use_id

### Phase 4 — End-to-End Investigation
- [ ] Full path: curl webhook → BullMQ → loop → LLM calls tool → runner executes → result → SQLite
- [ ] submit_investigation_result works end-to-end
- [ ] Verify with real running Docker container

### Phase 5 — Approval Flow
- [ ] WRITE_TOOLS set interception in loop.ts
- [ ] investigation/approvals.ts: requestApprovalAndExecute + Promise map
- [ ] notifications/slack.ts: approval card with Approve/Reject/Add Context
- [ ] Prisma schema: ApprovalRequest table
- [ ] End-to-end: alert → investigate → Slack approval → execute

### Phase 6 — Console
- [ ] Vite + React 19 scaffold
- [ ] TanStack Router: file-based routes
- [ ] TanStack Query: REST to API
- [ ] WebSocket hook: real-time incident feed
- [ ] Approval UI: Approve/Reject/Add Context

### Phase 7 — Hardening
- [ ] SQLite history loaded into initial investigation context
- [ ] request_clarification tool (add to TOOL_SCHEMAS)
- [ ] Reconnection resilience (exponential backoff both sides)
- [ ] Error handling: all 6 failure modes from PRD section 19
- [ ] Rate limiting dashboard indicator

## Architecture Decisions
- Full spec: PRD.md
- Tool definitions: PRD section 8
- Tech stack: PRD section 18.1
- Approval flow: PRD sections 6.5, 9.3, 13.2
- Session continuity: PRD section 10.6
