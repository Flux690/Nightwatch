# CONTEXT — Nightwatch

The single source of truth for what Nightwatch is, how it works end to end, the
domain language, and the architectural decisions. There is no separate PRD.md or
ADR directory; per-feature PRDs (`.claude/<feature>-prd.md`) link back here.

## What Nightwatch is

Nightwatch is a **self-hosted, open-source AI SRE agent** for developers and small
teams running production workloads on VPS servers with Docker (Kubernetes later).
When an alert fires, the agent investigates the infrastructure through real tools
(container logs, stats, events, host metrics, deploy history), determines the root
cause, proposes a fix, waits for human approval, executes it, and records the
outcome. The human stays in control of every state change; the agent does the 3am
work.

Positioning: *"Self-hosted AI SRE agent. One install, your servers, your data,
your API key."* No SaaS, no billing, no plans, no proxy inference. BYOK (bring
your own LLM key) is the only inference mode.

The 3am story the architecture must serve: alert fires → agent investigates
autonomously → proposes `restart_container` → **waits hours, durably, while the
operator sleeps** → operator wakes, sees the finding and the exact command, clicks
Approve → agent executes, verifies, records → next time the same failure recurs,
the agent already knows what fixed it.

## The OSS pivot (what changed and why)

Nightwatch v1 was designed as a SaaS: hosted API, pricing tiers, "installations"
as a billing/limiting concept, proxy inference, multi-tenant horizontal scaling.
The project pivoted to self-hosted OSS, which dissolved the rationale for most of
the v1 infrastructure:

- **"Installations" are gone.** The credential is a plain deployment **token**
  with a real lifecycle (mint, rotate, revoke). Nothing is counted or limited for
  pricing.
- **Redis + BullMQ are gone.** They existed for multi-instance SaaS scaling. A
  single-operator deployment is one Node process; queuing is an in-process
  dispatcher, live events are an in-process event bus.
- **Postgres + Prisma are gone.** The API's durable state is six small tables in
  one SQLite file.
- **"Runner is the system of record" is inverted.** That invariant existed so
  user data never touched the *hosted* API. Self-hosted, the API runs on the
  user's machine too, so the privacy rationale vanished — while the costs stayed
  (fragmented incident history across runners, a console that went blind when a
  runner was offline, best-effort persistence over WebSocket). Durable state now
  lives on the API; the runner is stateless.
- **Cut outright:** pricing/billing/Stripe, proxy inference, multi-tenant auth,
  on-call rotation, multi-user sync, installation limits.

## Components

```
Alertmanager / any webhook ──→ POST /alerts/ingest ─┐
Operator (console chat)    ──→ POST /chat ──────────┤
                                                    ▼
            API — the brain (one Node process, one SQLite file)
            dispatcher · agentic loop · interrupts · event bus
                  │ sendCommand over WSS                │ WS + REST
                  ▼ (outbound from runner)              ▼
            Runner(s) — the hands                  Console — the UI
            stateless executor per server          React, operator surface
            (docker socket, /proc)
```

- **API (the brain).** The only place an LLM is instantiated. Runs the agentic
  loop, owns all durable state, serves the console, talks to runners exclusively
  via `sendCommand`.
- **Runner (the hands).** A stateless executor installed on each server. Opens an
  outbound WSS connection (works behind any firewall/NAT, no inbound ports),
  sends a capability manifest, executes commands, returns results. Its only
  persistent state is its `runner-id` file. Side-effect-free reads; writes only
  via `commands/remediation.ts`.
- **Console (the UI).** Sessions, live transcript, approval/clarification cards,
  runner fleet, settings.

## State model

One SQLite file on the API (better-sqlite3, WAL mode). Six tables:

| Table | Holds |
|---|---|
| `tokens` | deployment credentials (SHA-256 hash, label, createdAt, lastUsedAt, revokedAt) |
| `config` | agent/model settings (one row; API key AES-256-GCM encrypted) |
| `sessions` | one row per session: id, token, title, originating alert (JSON), createdAt. Chat vs alert is derived from whether an originating alert exists, not stored |
| `session_messages` | the transcript; `UNIQUE(session_id, seq)`; `providerContent` JSON for exact provider-turn rebuild |
| `incidents` | currently escalation records only (root cause, action, resolution note, recurrence); finding extraction / episodic memory is deferred |
| `pending_interrupts` | the durable "waiting on a human" marker (see Interrupts) |

**Derived, never stored:**
- *running* = sessionId is in the in-memory active set (a crash means it is not
  running, so storing it would lie)
- *awaiting human* = a `pending_interrupts` row exists
- a session has **no status column and no run-state enum** — a session is a
  thread, not a state machine

The runner stores nothing. No history.db, no transcript tables.

## The loop (one loop, two triggers)

One agentic loop, one system prompt, one session type. An **alert** authors the
opening user message (alert + incident history context), or a **human** does
(chat). Same tools, same gates. The loop: `provider.chat()` → dispatch tool calls
(platform tools in-process, runner tools via `sendCommand`) → persist new
transcript turns locally in a transaction → repeat, until the model ends its
turn with plain text (no tool call = a successful finish), an interrupt, or a
budget exit.

**Persistence is transactional and local** — never best-effort, never remote. The
transcript is the checkpoint; `provider.seed(transcript)` rebuilds the in-memory
conversation with zero LLM calls.

### Interrupts (durable suspend/resume)

When the model calls a gated tool (`REQUIRES_APPROVAL`) or `request_clarification`:

1. Persist the assistant turn + one `pending_interrupts` row
   `{sessionId, toolUseId, kind, toolName, toolInput, completedResults, createdAt}`
   in the same transaction.
2. Publish the `INTERRUPT` event to the console.
3. **Return. The run ends.** Nothing waits in memory; no timer exists.

Resolution — whenever it arrives, minutes or hours later: execute the tool
(approve) / synthesize the rejection or answer (reject / clarify / other) →
append the tool_result → delete the row → reseed from the transcript →
redispatch. **Crash recovery is the same path** (the row and transcript survive a
restart; the console reads pending interrupts from the table on load, so the
attention queue is correct on first paint). There is no startup-recovery code by
design. This is the "defer" pattern from the Claude Code SDK: the wait outlives
the process, and the model sees a byte-identical conversation on resume.

Two kinds, one mechanism (`kind: approval | clarification`):

- **approval** — the card shows the exact command/input + risk. Actions:
  **Approve** / **Reject** (optional comment) / **Other** — typing in the
  composer while the interrupt is pending resolves it as added context the model
  adapts to.
- **clarification** — AskUserQuestion-shaped: the model supplies
  `{question, options[], multiSelect?}`; the console renders option buttons; the
  composer is the free-text "Other". No timeout — if the agent needs an answer at
  3am, waiting until 8am is correct.

**Mixed turns:** parallel tool calls are allowed (parallel reads across runners
are a core efficiency win). Non-gated tools in the turn execute first; their
results are stored on the interrupt row (`completedResults`) so the resumed run
can assemble the single tool_results message the provider contract requires.
Every tool_use is answered by exactly one tool_result.

**Budgets:** each dispatch gets a fresh `maxToolCalls` / `hardTimeoutMs` budget.
Resumes require a human action, so budgets cannot loop unattended.

**Escalation means the agent gave up - nothing else.** The two escalation paths
(model refusal, budget/timeout exhaustion) write an incident with an escalated
outcome and publish a console event. A human must be able to find out. Ending a
turn in plain text is a successful finish, not an escalation.

## Alert pipeline

1. **Validate the token** against the DB (hash lookup). Unknown token → 401.
   Never run an investigation for an unauthenticated alert.
2. Parse to `NormalizedAlert` (source-agnostic: anything that can POST a webhook).
3. **Dedup is derived, not stored:** an active run or pending interrupt with the
   same `token + sourceAlertId` → drop. A crashed run leaves no marker, so a
   re-fired alert correctly re-investigates.
4. Rate limit: in-memory counter per token (critical severity bypasses).
5. **Batch window (90s):** the first alert per token holds; same-token alerts
   arriving inside the window join it; one session opens with all of them so the
   model judges shared root cause. Crash during the window loses only the buffer
   — the alert re-fires. Correlated alerts are batched, never dropped.
6. Dispatch: bounded in-memory FIFO + concurrency cap (~30 lines). Queue full →
   log + drop (the alert re-fires).

**Mid-run injection:** a new alert for a token with an *actively running* session
goes into that run's in-memory inbox, drained at the next tool boundary into the
same user message as the tool results ("decide: downstream effect or independent
incident"). Suspended sessions never receive injections — a new session starts
instead. Inbox leftovers at run end become new sessions.

## Multi-runner

- Registry, manifests, and heartbeats are all keyed **(token, runnerId)** — never
  token alone (one runner must not overwrite another's manifest or keep a dead
  one looking alive).
- Routing: container-targeted commands resolve `containerName → runnerId` via the
  stored manifests; host-level commands take a `hostname` when more than one
  runner is registered; any-runner fallback only for single-runner deployments.
- A **session belongs to the deployment (token)** and may span runners. Approval
  cards are per write-action, not per runner.

## Token lifecycle

- Format: `nwr_` + 32 random bytes (crypto.randomBytes), base64url. The prefix
  makes tokens grep-able and secret-scanner-friendly.
- Stored as **SHA-256 hash only**; plaintext shown exactly once at mint.
- Lifecycle: **mint** (admin-authed), **revoke** (sets `revokedAt` and closes any
  live runner sockets on it), **rotate** = mint new + re-key runners (env var,
  restart) + revoke old.
- One token shared across all runners is the default (`runnerId` distinguishes
  them); minting per-server tokens is supported for finer revocation.

## Security invariants

- Every surface that accepts a token (ingest, chat, runner WS connect, console
  WS) validates it. The console WS authenticates like the REST routes.
- Bearer tokens never appear in identifiers, logs, or URLs we control
  (incident/session ids are UUIDs).
- The approval gate is architectural: a runner receives a write command only
  after a human resolved the interrupt. The LLM cannot tell the gate exists.
- Env var **values** are never read (names only). Log/tool content is untrusted
  data, never instructions. `read_file` enforces a path allowlist.
- `exec_command` is disabled unless `REMEDIATION_ENABLED=true` on the runner, and
  must report real exit codes.

## Console

Routes: `/` (welcome + composer; first message mints a session in place),
`/sessions/:id` (transcript), `/runners` (fleet by runner, not by token),
`/settings` (provider/model/loop config, token management, install command).

- **Attention queue** — global, shell-level count of sessions awaiting a human,
  read from `pending_interrupts` (correct on first load, live via WS).
- **Approval card** — exact command + risk + Approve/Reject; precedes the tool
  card; the composer is the "Other".
- **Clarification card** — option buttons + composer-as-Other.
- **Transcript** — one renderer for live and persisted views (role bubbles + tool
  cards with IN/OUT); the agent's closing plain-text turn renders as its answer;
  the words "conclude/concluded" never appear in the UI.
- **Composer** — always mounted; routed by state (new message / add-context); the
  API enforces 409 on sessions that are running.
- Design language: dark, high-contrast, terminal-adjacent; monospace for data,
  sans for prose.

## Glossary

- **API / brain** — the central service that reasons; the only LLM host; owner of
  all durable state.
- **Runner** — stateless in-network executor inside the user's trust boundary;
  reaches what the API can't (docker socket, /proc, k8s later). The "hands". Not
  a Docker thing — the capability manifest + `commands/*` dispatch generalises.
- **Console** — the operator UI.
- **Token** — the deployment credential (see lifecycle above).
- **Session** — a durable, resumable agentic thread; owns its id; entered via an
  alert or a human chat message. No status; never "concludes".
- **Run** — one dispatch of the loop over a session. Ephemeral. Ends when the
  model replies in plain text (no tool call), an interrupt, or a budget/escalation
  exit.
- **Interrupt** — the durable suspension of a run awaiting a human
  (`kind: approval | clarification`). The only gate mechanism.
- **Transcript** — the persisted `session_messages`; sufficient to rebuild exact
  provider turns on resume.
- **Incident** — optional child artifact of a session: currently an escalation
  record only. Finding extraction / episodic memory for future runs is deferred.
- **Trigger** — what starts a session: an alert or a human chat message. Derived
  from whether an originating alert exists, not stored as a field.
- **Escalate** — the agent hands off to the human, as a recorded incident + console
  event (never silently).
- **Integration** — a public-SaaS source the API reaches directly with a stored
  credential (GitHub, Slack…). Distinct from a runner: no in-network agent needed.
- **Vertical slice / tracer bullet** — an issue that cuts through all layers and
  is demoable on its own.
- **Deep module** — small stable interface hiding complex implementation; the
  preferred shape (one test boundary at the public seam).

Tool catalog: the source of truth is `packages/shared/src/tools.ts` +
`apps/api/src/investigation/tools.ts` (`PLATFORM_TOOLS`, `RUNNER_TOOLS`,
`REQUIRES_APPROVAL`).

## Decisions

- **D1 State inversion.** The API's SQLite file is the single system of record;
  the runner is stateless. Fixes fragmented multi-runner history, console
  blindness when a runner is down, and silent persistence holes; deletes
  Postgres, the relay cache, and four WS commands. The v1 invariant served a
  hosted API that no longer exists.
- **D2 No Redis, no BullMQ.** Single-process by design. Dispatcher = bounded
  in-memory FIFO + semaphore; streaming = in-process event bus; dedup/rate-limit
  = derived/in-memory. Horizontal scaling is a multi-tenant problem we don't have.
- **D3 Durable interrupts (defer, not pause).** The loop never awaits a human in
  memory. Suspend = transcript + one row; resume = seed + redispatch; crash
  recovery is the same path and costs zero extra code. Validated against the
  Claude Code SDK's own guidance for waits that outlive the process.
- **D4 No speculative state.** No status enums, no checkpoint/job/audit tables.
  Anything derivable is derived; the transcript is the audit trail.
- **D5 Single admin, deployment token.** One operator owns the deployment;
  tokens are hashed credentials with mint/rotate/revoke.
- **D6 BYOK only.** The operator brings an Anthropic/OpenAI-compatible key;
  provider abstraction is a hand-rolled port + two adapters (`createProvider`).
  No proxy inference.
- **D7 No framework loop.** ~300 lines of TypeScript; every line in the critical
  path readable at 3am. No LangChain/LangGraph/CrewAI.
- **D8 Unified session model.** One loop, two triggers; chat and alert are entry
  points, not subsystems. The loop input is session-shaped (no synthetic alerts).
- **D9 Parallel tool calls kept.** Completed results ride the interrupt row so
  mixed turns suspend cleanly. Parallel reads across runners are a core win.
- **D10 Every tool_use is answered by exactly one tool_result** (provider
  contract; injections ride inside the tool_results user message).
- **D11 better-sqlite3 everywhere, no ORM.** Six tables don't need Prisma;
  synchronous, transactional, one driver.
- **D12 Episodic memory is plain text.** Recent incident records injected at run
  start. No vector store, no embeddings, no RAG at this scale.
- **D13 BYO monitoring.** We never own monitoring; anything that can POST a
  webhook is a signal source. The bundled Prometheus/Alertmanager/cAdvisor
  container is a convenience for users who have nothing.

## Deliberately not built

Horizontal scaling / multi-instance APIs · vector stores / RAG · billing, plans,
multi-tenant auth · on-call rotation / multi-user sync · log aggregation, metrics
storage, APM (Prometheus/Loki/Datadog exist) · runbook automation (the LLM is the
runbook) · auto-update of runners.

## Workflow

- Backlog: `issues/` (see `issues/README.md`). Per-feature PRDs:
  `.claude/<feature>-prd.md` (from `/to-prd`), cut into vertical slices by
  `/to-issues`.
- Architecture invariants enforced per session: `.claude/rules/architecture.md`.
- v1 SaaS-era docs (PRD, phase plan, ADRs) were removed in the OSS pivot; git
  history preserves them.
