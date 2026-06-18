# Nightwatch v2 — Full Codebase Review & Fix Report

> Generated: 2026-06-18  
> Reviewer: Independent third-party code review (Agent 3)  
> Branch: v2  
> Scope: Every source file across apps/api, apps/runner, apps/console, packages/shared

---

## How to Read This Report

Issues are grouped by category and ordered by urgency within each category. Each
issue has:
- **Status**: what the code does today
- **Why it matters**: the specific failure mode, not abstract concern
- **Fix**: concrete change with exact file and line references

---

## Category S — Security (Fix First)

These issues either expose data to unauthenticated callers or leak credentials
into log surfaces.

---

### S1: Four Unauthenticated API Endpoints

Three read endpoints that should require a session cookie do not.

#### S1a: `GET /runners` — leaks infrastructure topology

**File:** [apps/api/src/runners/routes.ts:16](../apps/api/src/runners/routes.ts)

```typescript
fastify.get("/runners", () => {   // no { preHandler: requireSession }
```

**What it returns:** the full runner fleet — hostnames, container names, capability
manifests (including which ports are open, whether remediation is enabled,
Prometheus/Redis/Postgres configuration).

**Why it matters:** Anyone with network access to your API port can enumerate
your entire infrastructure topology without logging in. There is no rate limit on
this route. The `PATCH /runners/:tokenId/rules` route two lines below it has
`requireSession` — the omission on the GET is inconsistent and unintentional.

**Confirmed by test:** [apps/api/src/tests/multi-runner-registry.test.ts:83](../apps/api/src/tests/multi-runner-registry.test.ts)
calls `GET /runners` with no auth cookie and expects 200. The test proves the
missing guard, not that the behavior is correct.

**Fix:** Add `{ preHandler: requireSession }` as the second argument to
`fastify.get("/runners", ...)`.

---

#### S1b: `GET /config/models` — leaks provider configuration

**File:** [apps/api/src/config/routes.ts:152](../apps/api/src/config/routes.ts)

```typescript
fastify.get("/config/models", async () => {   // no requireSession
```

**What it returns:** calls out to your configured LLM provider (Anthropic,
OpenAI, OpenRouter, Ollama) using your stored and encrypted API key, then returns
the available model list. An unauthenticated caller learns: which provider you
use, which base URL, and what models are available.

**Why it matters:** Confirms which LLM vendor and model configuration is in use.
Also triggers an outbound API call using your credentials on every unauthenticated
request — a cheap way to burn your rate limit or probe for API key validity
indirectly.

**Confirmed by test:** [apps/api/src/tests/provider-model-config.test.ts:143](../apps/api/src/tests/provider-model-config.test.ts)
calls `GET /config/models` with no auth and expects 200.

**Fix:** Add `{ preHandler: requireSession }` to the route registration.

---

#### S1c: `GET /incidents/pending` — leaks pending approvals

**File:** [apps/api/src/incidents/routes.ts:58](../apps/api/src/incidents/routes.ts)

```typescript
fastify.get("/incidents/pending", async () => ({
  pending: listAllInterrupts().map(toApprovalRequest),
}));
// no { preHandler: requireSession }
```

**What it returns:** all pending human approval requests, including the tool name
(e.g. `restart_container`), the tool's full input (container name, rationale,
risk level, estimated downtime), and the session/incident IDs.

**Why it matters:** Exposes every pending remediation action waiting for operator
approval — what the AI wants to do to which containers, and why. This is
sensitive operational state.

**Additional context:** There is a parallel route `/approvals/pending` at
[apps/api/src/approvals/routes.ts:23](../apps/api/src/approvals/routes.ts) that
returns essentially the same data (also calls `listAllInterrupts()`) and correctly
has `requireSession`. The `/incidents/pending` route is a duplicate that was never
gated.

**Fix:** Add `{ preHandler: requireSession }` to the route registration.

---

#### S1d: `GET /incidents/:id/status` — leaks full investigation transcripts

**File:** [apps/api/src/incidents/routes.ts:396](../apps/api/src/incidents/routes.ts)

**What it returns:** the full investigation status for any incident by ID —
including the complete conversation transcript between the LLM and your
infrastructure.

**Why it matters:** Investigation transcripts contain detailed observations about
your system: container states, log excerpts, identified root causes, environment
variable names, disk and memory states. Incident IDs are sequential integers
(SQLite AUTOINCREMENT), so an attacker with network access can enumerate all
incidents from 1 upward.

**Fix:** Add `{ preHandler: requireSession }` to the route registration.

---

### S2: Runner Token Appears in Webhook URL Query Parameter

The runner token ends up in the Alertmanager webhook URL as a query parameter.
This violates the architecture invariant: "Tokens are stored as SHA-256 hashes;
plaintext is shown once at mint and never appears in logs, identifiers, or URLs
we control." (CONTEXT.md)

#### Two affected locations:

**Location 1:** [apps/runner/install/configs/alertmanager.yml:14](../apps/runner/install/configs/alertmanager.yml)
```yaml
- url: "${PLATFORM_URL}/alerts/ingest?token=${NIGHTWATCH_TOKEN}"
```

**Location 2:** [apps/api/src/connect/connect.sh:119](../apps/api/src/connect/connect.sh)
(the echo that tells users with existing Alertmanager deployments how to configure it)
```bash
echo "        - url: '${PLATFORM_URL}/alerts/ingest?token=${NIGHTWATCH_TOKEN}'"
```

**Where the token lands when it's in the URL:**
1. Alertmanager's own config file on disk
2. Alertmanager's outbound request logs
3. Your API server's access log (pino logs every inbound request including the
   full path)
4. Any reverse proxy or load balancer access log between Alertmanager and the API

**The ingest route already supports a header:** [apps/api/src/alerts/ingest.ts:20-22](../apps/api/src/alerts/ingest.ts)
reads `X-Nightwatch-Token` header first, falls back to `?token=` query param.
The server-side support for the secure path already exists.

**Fix:**

In `alertmanager.yml`, use Alertmanager's `http_config.authorization`:
```yaml
receivers:
  - name: nightwatch
    webhook_configs:
      - url: "${PLATFORM_URL}/alerts/ingest"
        http_config:
          authorization:
            credentials: "${NIGHTWATCH_TOKEN}"
        send_resolved: true
```

In `connect.sh`, update the echo to output the same header-based config. The
ingest route's `extractToken()` function already handles `Authorization: Bearer
<token>` or `X-Nightwatch-Token: <token>` — either works.

---

### S3: Plaintext Runner Token Embedded in CapabilityManifest

The runner sends its own plaintext token to the API as part of every connection
handshake.

**Root cause:** [packages/shared/src/runner.ts:2](../packages/shared/src/runner.ts)

```typescript
export interface CapabilityManifest {
  token: string;   // carries the plaintext token
  ...
}
```

**Where the plaintext comes from:** [apps/runner/src/manifest/detect.ts:19](../apps/runner/src/manifest/detect.ts)
```typescript
token: process.env["NIGHTWATCH_TOKEN"] ?? "unknown",
```

**Where it goes:** [apps/runner/src/websocket/client.ts:42-49](../apps/runner/src/websocket/client.ts)
serializes the manifest to JSON and sends it over the WebSocket. The API stores
it in the in-memory registry (a field on every `RunnerConnection`).

**Why it matters:** The API already has the `tokenId` (the SHA-256 hash) as the
registry key at connect time. The manifest's `token` field is a SaaS-era remnant
that predates the hashed-storage design — there is zero architectural reason for
the manifest to carry the plaintext. If the API ever debug-logs the manifest
(e.g. on a connection error), the token appears in the log.

**Fix:**
1. Remove `token: string` from `CapabilityManifest` in `packages/shared/src/runner.ts`
2. Remove the `token:` line from `detect.ts`
3. Update any callers that read `manifest.token` — search the codebase for
   `.token` on manifest objects and replace with the `tokenId` from the registry
   key (which is always available in context wherever the manifest is used)

---

## Category C — Investigation Loop Correctness (Fix Second)

These issues corrupt the LLM conversation state or allow double-execution of
remediation commands.

---

### C1: Critical-Severity Rejection Orphans the LLM Transcript

This is the highest-priority correctness bug. It leaves sessions in a state they
cannot recover from without manual database intervention.

**File:** [apps/api/src/incidents/routes.ts:193-211](../apps/api/src/incidents/routes.ts)

**What the code does for critical rejection:**
```typescript
if (severity === "critical") {
  const ctx = { ... };
  escalate(ctx, id, sessionId, `Write action rejected: ${toolName}`);

  const response: ApprovalResponse = { ... };
  return reply.code(200).send(response);   // ← returns here, never dispatches
}
```

**What the code does for non-critical rejection** (lines 214-234):
```typescript
const resumeToolResults: ToolResult[] = [...completedResults, gatedResult];
const seed = buildSeed(sessionId);
dispatcher.dispatch({ sessionId, token, seed, resumeToolResults });
return reply.code(200).send(response);
```

**The problem, in plain terms:**

When the AI wants to perform a dangerous action (e.g. `restart_container`), it
issues a `tool_use` message. The system pauses and waits for approval. The
conversation history in `session_messages` now ends with:

```
[assistant]: I want to restart container "api". [TOOL_USE id=toolu_abc123]
```

For non-critical rejection: the code sends back a `tool_result` saying "rejected."
The LLM sees the answer, processes it, and can respond ("understood, I'll try a
different approach"). Session is alive.

For critical rejection: the code deletes the interrupt row and returns 200. The
LLM's conversation history still ends with the unanswered `tool_use`. No
`tool_result` is ever stored. The interrupt row is gone so the UI shows no
pending approvals.

Now if you open the chat and type anything — even just "what happened?" — the
backend sends your message to the Anthropic API with the full conversation
history. The API sees: last assistant message was `tool_use`, next user message
is plain text. This violates the Anthropic API's strict message structure
requirement. It returns HTTP 400. The session is stuck permanently.

**Fix:**

Move the critical branch's return *after* the dispatch, same as non-critical.
The `escalate()` call for paging is independent and should still fire — these
two concerns are separate.

```typescript
if (severity === "critical") {
  const ctx = { ... };
  // Escalate first (paging/notification is independent of session state).
  escalate(ctx, id, sessionId, `Write action rejected: ${toolName}`);
}

// Both critical and non-critical: dispatch the rejection tool_result so the
// LLM transcript is never left with an unanswered tool_use.
const resumeToolResults: ToolResult[] = [...completedResults, gatedResult];
const seed = buildSeed(sessionId);
dispatcher.dispatch({ sessionId, token, seed, resumeToolResults });
return reply.code(200).send(response);
```

**On the content of `gatedResult`:**

The current content string (line 168) is:
```typescript
content: `Rejected by operator: ${request.body?.comment ?? "no comment"}`,
is_error: true,
```

Two problems with this:
1. `is_error: true` signals a tool execution failure, not a human decision. The
   LLM may interpret it as a transient infrastructure error and retry the same
   command. Operator rejection is a deliberate human decision — it should not use
   the error flag.
2. The content doesn't tell the LLM the action was NOT taken or what to do next.

**Recommended content for non-critical rejection:**
```
The operator rejected this tool use. The action was NOT executed — no changes
were made to the system. Operator comment: "${comment}". Stop the current
remediation approach, explain to the operator why you chose this tool and what
you were trying to achieve, and ask for guidance on how to proceed.
```

**Recommended content for critical rejection:**
```
The operator rejected this tool use as too risky. The action was NOT executed —
no changes were made to the system. Operator comment: "${comment}". This incident
has been escalated to on-call. Stop the investigation. Do not attempt further
remediation. Summarize what you observed and what you were attempting to do so
the on-call engineer has context when they take over.
```

Remove `is_error: true` from both. Use two separate `gatedResult` constructions
— one per severity branch — with the appropriate content above.

---

### C2: Approval Race Condition — Wrong Call Order

**File:** [apps/api/src/incidents/routes.ts:68-147](../apps/api/src/incidents/routes.ts)

**Current flow:**
```
1. getInterruptWithSession(id)    ← fetch the interrupt row
2. sendCommand(...)               ← await runner (10-30 seconds)
3. deleteInterrupt(id)            ← atomic delete, returns false if already gone
```

**The race:** Two concurrent POST requests to `/incidents/:id/approve` both reach
step 1 and get the interrupt row before either completes step 2. Both then call
`sendCommand`. Both execute the remediation command. Only one gets `false` from
`deleteInterrupt` at step 3 — but the damage (double execution) has already
happened.

The race window is not milliseconds — it is the full execution time of the runner
command, which for a remediation action (`restart_container`, `rollback_deploy`,
`exec_command`) is easily 10-30 seconds.

**The correct fix — `claimed_at` atomic claim:**

The fix is not simply swapping the call order (delete first, then send), because
that introduces a crash-recovery gap: if the API crashes after delete but before
`sendCommand`, the interrupt row is gone and the session is stuck (same state as
the critical rejection bug above). There is no way to recover.

The correct approach:

**Step 1:** Add a nullable `claimed_at TEXT` column to `pending_interrupts`:
```sql
ALTER TABLE pending_interrupts ADD COLUMN claimed_at TEXT;
```

**Step 2:** Replace the fetch with an atomic test-and-set:
```typescript
// In db/interrupts.ts — add this function:
export function claimInterrupt(id: string): PendingInterruptWithSession | null {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db
    .prepare(`UPDATE pending_interrupts SET claimed_at = ? WHERE id = ? AND claimed_at IS NULL`)
    .run(now, id);
  if (result.changes === 0) return null;   // already claimed — 409
  return getInterruptWithSession(id);
}
```

SQLite serializes this UPDATE. Only one concurrent request gets `changes = 1`.
All others get `null` and return 409. The winner proceeds to `sendCommand`, then
`deleteInterrupt`.

**Step 3:** On API restart, reset orphaned claims:
```typescript
// In db/interrupts.ts:
export function resetOrphanedClaims(): void {
  getDb()
    .prepare(`UPDATE pending_interrupts SET claimed_at = NULL WHERE claimed_at IS NOT NULL`)
    .run();
}
```

Call this from `initDb()` in `db/client.ts`. Claimed-but-not-deleted rows (from
a crash between claim and send) re-appear as pending approvals. The admin sees
them again and re-approves. No command executes without explicit approval.

This is the complete fix: one column, one new function, one startup call. The
table rename and other structural changes suggested in earlier analysis are not
needed.

---

## Category A — Architecture (Address Next)

These issues are correctness gaps against the architecture decisions in CONTEXT.md.
They don't cause active failures in single-runner deployments but must be
addressed before multi-runner support is usable.

---

### A1: Runner Identity (runnerId) Is Not Transmitted to the API

**Context:** CONTEXT.md Decision D14 specifies a "flat runner registry keyed by
runnerId." The current registry is keyed by `tokenId` — the SHA-256 hash of the
token.

**Current state across files:**

- [apps/runner/src/manifest/identity.ts](../apps/runner/src/manifest/identity.ts):
  `getRunnerId()` generates a stable UUID and persists it to disk. Works correctly
  as a stable identity primitive.
- [apps/runner/src/manifest/detect.ts](../apps/runner/src/manifest/detect.ts):
  Never calls `getRunnerId()`. The manifest sent to the API does not include
  `runnerId`.
- [packages/shared/src/runner.ts](../packages/shared/src/runner.ts):
  `CapabilityManifest` has no `runnerId` field.
- [apps/api/src/ws/router.ts:37](../apps/api/src/ws/router.ts):
  `registry = new Map<string, RunnerConnection>()` keyed by `tokenId`.

**Why this matters (first principles):**

A token is a credential — its lifecycle is tied to security policy. If a token is
leaked and must be revoked, you issue a new one. A `runnerId` is an identity — its
lifecycle is tied to the machine.

With the current design, revoking and reissuing a token makes the API treat the
reconnecting runner as a brand-new server. The runner's historical record is tied
to sessions (which are keyed by `sessionId`, not `tokenId`) so investigation
history is not technically lost — but the ability to say "show me everything that
ever happened on server X" across a credential rotation is broken.

**Current routing mitigates but does not eliminate the gap:**

[apps/api/src/ws/router.ts:123-175](../apps/api/src/ws/router.ts) — `resolveRunner()`
routes by `containerName` (manifest lookup) and `hostname`. For single-runner
deployments the shortcut at line 128 handles everything. For multi-runner
deployments, routing by container and hostname works — until two servers have the
same container name, in which case routing is first-match (non-deterministic).

**Fix:**

This is issue 037. The pieces are in place:

1. Add `runnerId: string` to `CapabilityManifest` in `packages/shared/src/runner.ts`
   (also remove `token: string` from the same interface per S3)
2. Call `getRunnerId()` in `detect.ts` and include it in the returned manifest
3. Change `RunnerConnection` in `ws/router.ts` to store `runnerId`
4. Key the registry by `runnerId` instead of `tokenId`
5. Keep `tokenId` as the authentication field on `RunnerConnection` (used by
   `closeTokenRunners()` for immediate revocation)
6. Update `resolveRunner()` to support explicit `runnerId` routing as a fourth
   branch, alongside existing container/hostname routing

The `sendCommand`'s `_tokenId` parameter (line 179) is vestigial — it can be
removed or renamed to `runnerId` if routing-by-runnerId is added as a branch.

---

### A2: `sendCommand` Has a Vestigial `_tokenId` Parameter

**File:** [apps/api/src/ws/router.ts:178-179](../apps/api/src/ws/router.ts)

```typescript
export function sendCommand(
  _tokenId: string,   // ← underscore prefix = unused, intentionally ignored
  commandName: string,
  ...
```

This parameter was the original routing key. The function now ignores it and uses
`resolveRunner(commandInput)` instead. The underscore prefix signals intentional
non-use, but it creates confusion: callers (e.g. `incidents/routes.ts:81`) pass
`token` as the first argument as if it affects routing — it doesn't.

**Fix:** Remove the parameter. Update all call sites to pass two arguments
(`commandName`, `commandInput`). If A1 is implemented, replace it with a
`runnerId: string | null` parameter that `resolveRunner` can use as an explicit
routing hint.

---

## Category D — Technical Debt (Clean Up)

These are not active failures but create confusion or will cause problems as the
codebase evolves.

---

### D1: `sessions` Schema Has a Stale `token TEXT NOT NULL` Column

**File:** [apps/api/src/db/client.ts:52-56](../apps/api/src/db/client.ts)

```sql
CREATE TABLE IF NOT EXISTS sessions (
  session_id        TEXT PRIMARY KEY,
  token             TEXT NOT NULL,   -- ← SaaS-era remnant
  ...
```

Commit 122979a "remove token column, key by session uuid" describes removing this
column, but it was not removed from the schema. The HTTP session routes now use
`listAllSessions()` which doesn't filter by token. The column exists, consumes
space, and misleads anyone reading the schema about what "token" means in a
session context.

**Cascading:** [packages/shared/src/sessions.ts](../packages/shared/src/sessions.ts)
still has `SessionMeta.token: string` as a required field. `createSession` in
`db/sessions.ts` still takes and stores it. This chain means removing the column
requires coordinating: shared type → db layer → all createSession call sites.

**Fix:** Remove `token: string` from `SessionMeta` in shared, remove it from
`createSession`'s interface in `db/sessions.ts`, update all call sites, then
drop the column from the schema. Coordinate in one commit (monorepo rule: shared
type changes must update all importers in the same commit).

---

### D2: Dead Test Code — `X-Nightwatch-Runner-Id` Header

**File:** [apps/api/src/tests/token.test.ts:213-269](../apps/api/src/tests/token.test.ts)

Multiple tests send `X-Nightwatch-Runner-Id` as a WebSocket connection header.
[apps/api/src/ws/server.ts](../apps/api/src/ws/server.ts) never reads this header
— it was removed in commit 856f370 ("remove runnerId from WS layer, key registry
by tokenId") but the tests were not updated. The header is silently ignored. These
tests are asserting behavior that doesn't exist in the implementation.

**Fix:** Remove the `X-Nightwatch-Runner-Id` header from the test WS connection
setup. If A1 (runnerId restoration) is implemented, update the tests to match the
new mechanism (runnerId in manifest, not in the WS connect header).

---

### D3: SaaS Fallback URLs in Runner

Two hardcoded SaaS-era URLs remain as fallback defaults:

**Location 1:** [apps/runner/src/websocket/client.ts:20](../apps/runner/src/websocket/client.ts)
```typescript
process.env["WS_URL"] ?? "wss://api.nightwatch.sh/clients/connect"
```

**Location 2:** [apps/runner/install/configure.sh:4](../apps/runner/install/configure.sh)
```sh
PLATFORM_URL="${PLATFORM_URL:-https://api.nightwatch.sh}"
```

In a self-hosted deployment, if `WS_URL` or `PLATFORM_URL` is accidentally unset,
the runner silently connects to the old SaaS endpoint rather than failing fast
with a clear error. This makes misconfiguration silent.

**Fix:** Replace the fallback strings with a required-variable check:

In `client.ts`:
```typescript
const wsUrl = process.env["WS_URL"];
if (!wsUrl) throw new Error("WS_URL is required");
```

In `configure.sh`:
```sh
PLATFORM_URL="${PLATFORM_URL:?PLATFORM_URL is required}"
```

The `configure.sh` already does this pattern correctly for `NIGHTWATCH_TOKEN`
(line 5: `NIGHTWATCH_TOKEN="${NIGHTWATCH_TOKEN:?NIGHTWATCH_TOKEN is required}"`).

---

## Summary — Fix Priority Order

| Priority | ID  | Issue | Category | Effort |
|----------|-----|-------|----------|--------|
| 1 | S1a | `GET /runners` — no auth | Security | 1 line |
| 1 | S1b | `GET /config/models` — no auth | Security | 1 line |
| 1 | S1c | `GET /incidents/pending` — no auth | Security | 1 line |
| 1 | S1d | `GET /incidents/:id/status` — no auth | Security | 1 line |
| 2 | C1  | Critical rejection orphans transcript + bad tool_result content | Correctness | ~20 lines |
| 3 | S2  | Token in webhook URL | Security | Config change |
| 4 | C2  | Approval race condition (claimed_at) | Correctness | ~30 lines + 1 migration |
| 5 | S3  | Plaintext token in CapabilityManifest | Security | Multi-file refactor |
| 6 | A1  | runnerId not transmitted to API | Architecture | Issue 037 |
| 7 | A2  | `sendCommand` vestigial `_tokenId` param | Architecture | Cleanup |
| 8 | D1  | sessions schema stale `token` column | Tech Debt | Multi-file refactor |
| 9 | D2  | Dead `X-Nightwatch-Runner-Id` test header | Tech Debt | Test cleanup |
| 10 | D3 | SaaS fallback URLs in runner | Tech Debt | 2 lines |

---

## Issues Confirmed as Non-Problems

**Auth status route at `/auth/status` vs `/api/auth/status`:**
Not a real issue. All routes in `registerAuthRoutes` are registered directly on
the root Fastify instance with no prefix (confirmed in `index.ts:38`). The route
is at `/auth/status`, which is where `index.ts` registers it. If a PRD said
`/api/auth/status`, the PRD is stale.

**Volume mount in `connect.sh`:**
The `-v nightwatch-data:/var/nightwatch` mount at line 72 is required and
correct. `apps/runner/src/manifest/identity.ts` persists the stable `runnerId`
to a file path derived from `NIGHTWATCH_DB_PATH` (`/var/nightwatch/history.db`).
Without the volume, the runner-id file is lost on container restart and D14's
stable identity invariant breaks. Do not remove this mount.

**`deleteInterrupt` returning `false` as the concurrency guard:**
This function is correct as-is. The boolean return is the right primitive. The
problem is not `deleteInterrupt` itself — it's that the caller in the approve
route calls it too late (after `sendCommand`). The C2 fix preserves
`deleteInterrupt` unchanged and adds the `claimInterrupt` step before it.
