# Refactor Report - 2026-06-18

Branch: `v2`

Primary local commits covered in this report:

1. `ec8c370` - `fix(api,runner): harden runner auth and alert token transport`
2. `ee9db1c` - `refactor(api): remove live incidents and rekey investigation flow by session and runnerId`

This report covers the full implementation work completed in this session, including the refactor intent, the issues that existed before the changes, the fixes that were introduced, the concrete file-level changes that implemented those fixes, the debugging/failure patterns encountered during the work, and the final validated state of the repository.

## 1. Executive Summary

This session started from a review-driven architecture cleanup effort. The codebase had three broad problems:

1. Security and transport issues on important API surfaces.
2. A live control plane that still revolved around `incidents`, `interrupts`, and token-shaped identity even though the real durable thread was already the session transcript.
3. A runtime identity model that conflated authentication (`tokenId`) with durable machine identity (`runnerId`), which created routing, deduplication, and lifecycle inconsistencies.

The work therefore landed in two large slices.

The first slice hardened exposed routes and removed insecure token transport. The second slice performed the architectural refactor: it removed live incident-backed control-plane behavior, moved all human intervention onto session-scoped durable human input, removed token coupling from session state, restored `runnerId` as the stable routing identity, rewired alert dedup/rate-limit/dispatch behavior around that identity, and rewrote the affected tests and console flows.

At the end of the session, the repository was validated green with:

- `pnpm typecheck`
- `pnpm test`

## 2. Baseline Problems Identified In This Session

### 2.1 Security and Surface Hardening Problems

The review and repo audit surfaced the following concrete problems:

- `GET /runners` was readable without the owner session cookie.
- `GET /config/models` was readable without the owner session cookie.
- Generated Alertmanager/install output still encouraged token-in-query transport.
- `/alerts/ingest` needed an explicit secure header-based auth path aligned with generated configuration.
- The runner manifest still exposed sensitive token-related transport assumptions that did not belong in normal capability exchange.

### 2.2 Control-Plane Design Problems

The live control plane still encoded an older model:

- `incidents` were being treated as a first-class live operational concept.
- pending human intervention was modeled as `interrupts`, addressed partly by incident-oriented identifiers.
- escalation still assumed a separate incident-style persistence path rather than the session transcript.
- there were duplicated or overlapping routes for pending approvals and incident-centric human actions.

This was overcomplicated because the real durable unit of work was already the session transcript and its associated session id.

### 2.3 Identity Problems

The refactor planning phase established that `tokenId` and `runnerId` had drifted into conflicting roles:

- `tokenId` is authentication lifecycle state.
- `runnerId` is durable machine identity.
- The previous implementation still routed some runtime behavior as though the token were the durable machine key.

This showed up in deduplication, alert batching, rate limiting, WebSocket registry semantics, and test assumptions.

### 2.4 Session-Model Problems

The session model still carried token coupling that no longer matched the desired architecture:

- `SessionMeta` still contained token-oriented assumptions.
- chat sessions were created with placeholder token semantics.
- some console/API flows still depended on runner-token discovery for data that should be session-scoped and operator-scoped.

## 3. Work Completed In Commit `ec8c370`

Commit subject:

`fix(api,runner): harden runner auth and alert token transport`

### 3.1 Issue

The codebase exposed sensitive operational surfaces without session auth and still used an insecure or at least undesirable token transport pattern through generated Alertmanager/connect output.

### 3.2 Fix

The first commit performed the security hardening slice before the deeper refactor. This was the correct ordering because these fixes were independently valuable and reduced exposure immediately.

### 3.3 Changes Introduced

- gated `GET /runners` behind owner-session auth.
- gated `GET /config/models` behind owner-session auth.
- updated generated connect/install output to remove token-in-query guidance.
- aligned Alertmanager templates to use an explicit header-based auth flow.
- updated `/alerts/ingest` to support the chosen secure auth path.
- stopped putting the plaintext runner token in the runner capability manifest.
- updated shared runner manifest types and tests to match the hardened transport.

### 3.4 Key Files Changed

- `apps/api/src/alerts/ingest.ts`
- `apps/api/src/config/routes.ts`
- `apps/api/src/connect/connect.sh`
- `apps/api/src/runners/routes.ts`
- `apps/runner/install/configs/alertmanager.yml`
- `apps/runner/install/configs/alertmanager.dev.yml`
- `apps/runner/src/manifest/detect.ts`
- `packages/shared/src/runner.ts`
- related tests in `apps/api/src/tests/*`

### 3.5 Why This Slice Mattered

This slice closed real exposure regardless of the larger refactor. Even if the incident/human-input simplification had been delayed, these fixes still needed to land.

## 4. Work Completed In Commit `ee9db1c`

Commit subject:

`refactor(api): remove live incidents and rekey investigation flow by session and runnerId`

This was the large architectural slice. It touched the API, shared contracts, console, runner manifest shape, storage schema, and tests.

### 4.1 Problem: Live Incident Control Plane Was Overbuilt

#### Issue

The code still treated `incidents` as part of the live operating model even though the durable thread of investigation was the session transcript. That created redundant persistence, duplicate routes, stale prompt/tool behavior, and test complexity around a concept that was no longer the right source of truth.

#### Fix

The refactor removed incident-backed live behavior and moved escalation to a session-level transcript/event model.

#### Corresponding Changes Introduced

- removed live incident-route registration from the main API path.
- removed incident-history prompt/tool integration from the investigation flow.
- stopped minting and threading `incidentId` through active investigations.
- rewrote escalation to append transcript evidence and publish `ESCALATED` rather than writing a live incident row as part of the control plane.
- rewrote escalation tests to assert transcript + event behavior.

#### Primary Files

- `apps/api/src/index.ts`
- `apps/api/src/incidents/routes.ts`
- `apps/api/src/investigation/context.ts`
- `apps/api/src/investigation/platform.ts`
- `apps/api/src/investigation/tools.ts`
- `apps/api/src/investigation/result.ts`
- `apps/api/src/tests/escalation.test.ts`
- `apps/api/src/tests/state-inversion.test.ts`

### 4.2 Problem: Human Intervention Was Not Properly Session-Scoped

#### Issue

The old `interrupt` model was partly incident-shaped and carried unnecessary identity complexity. The system allows only one pending human wait per session, so separate interrupt identifiers were unnecessary operationally.

#### Fix

The pending-human-input model was made explicitly session-scoped and durable.

#### Corresponding Changes Introduced

- replaced `pending_interrupts` with `pending_human_input` in the SQLite schema.
- made `session_id` the durable identity for the pending-human-input row.
- added `claimed_at` support to handle approval claiming safely.
- rewrote the DB layer around `PendingHumanInput` and `PendingHumanInputWithSession`.
- renamed the queue endpoint to `GET /sessions/pending-human-input`.
- made human actions session-scoped: approve, reject, answer, add-context.
- changed websocket event names to `HUMAN_INPUT_REQUIRED` and `HUMAN_INPUT_RESOLVED`.
- updated the console session transcript and chat input flows to target the new routes and event names.

#### Primary Files

- `apps/api/src/db/client.ts`
- `apps/api/src/db/interrupts.ts`
- `apps/api/src/human-input/service.ts`
- `apps/api/src/session/stream.ts`
- `apps/api/src/sessions/routes.ts`
- `apps/api/src/chat/routes.ts`
- `apps/console/src/pages/ChatInput.tsx`
- `apps/console/src/pages/SessionTranscript.tsx`
- `packages/shared/src/approvals.ts`
- `packages/shared/src/ws.ts`

### 4.3 Problem: Critical Rejection and Human-Input Completion Semantics Were Fragile

#### Issue

The original flow could leave a critical rejection in an awkward or transcript-incoherent state. The system needed to guarantee that human decisions still produce a coherent provider transcript and a valid resumed run shape.

#### Fix

Human-input completion logic was centralized in `apps/api/src/human-input/service.ts` and updated so both approval and rejection paths preserve a coherent transcript contract.

#### Corresponding Changes Introduced

- added atomic-style claim handling via `claimed_at` support.
- reset orphanable claim state at startup through schema initialization behavior.
- changed rejection semantics from “tool failure” to “human decision” for non-critical rejection.
- kept critical rejection in the core loop by escalating and also resuming with a valid tool-result continuation path so the transcript ends coherently.
- centralized action handling in `human-input/service.ts` instead of scattering business logic across routes.

#### Primary Files

- `apps/api/src/human-input/service.ts`
- `apps/api/src/db/client.ts`
- `apps/api/src/db/interrupts.ts`
- `apps/api/src/investigation/loop.ts`
- `apps/api/src/tests/approval-cycle.test.ts`
- `apps/api/src/tests/clarification-interrupt.test.ts`

### 4.4 Problem: Session State Still Carried Token Coupling

#### Issue

Sessions were still partially modeled as token-scoped runtime objects even though tokens are auth lifecycle state, not the durable identity of the conversation.

#### Fix

The refactor removed token coupling from the session model and session routes.

#### Corresponding Changes Introduced

- removed `token` from `SessionMeta`.
- removed token-oriented assumptions from session reads/writes.
- removed placeholder token behavior from chat session creation.
- updated session listing and transcript access flows to work as operator/session-scoped reads.
- updated token-related tests to verify that deleting tokens does not break session visibility.

#### Primary Files

- `packages/shared/src/sessions.ts`
- `apps/api/src/db/sessions.ts`
- `apps/api/src/chat/routes.ts`
- `apps/api/src/sessions/routes.ts`
- `apps/api/src/tests/session-store.test.ts`
- `apps/api/src/tests/token.test.ts`

### 4.5 Problem: Runtime Identity Used TokenId Where RunnerId Was Required

#### Issue

The previous state of the code still used token-shaped identity in places where the system needed stable machine identity. This created conceptual and operational drift across:

- alert ingestion
- deduplication
- rate limiting
- active investigation tracking
- runner registry semantics
- runner command routing

#### Fix

The refactor restored `runnerId` as the durable runtime identity and retained `tokenId` only for auth and revocation.

#### Corresponding Changes Introduced

- added `runnerId` to `CapabilityManifest`.
- added `runnerId` to `NormalizedAlert`.
- persisted `runnerId` on token rows to bridge authenticated token use to stable runner identity.
- keyed active investigation dedup and related alert handling by `runnerId + sourceAlertId`.
- rewrote the WebSocket runner registry to track connections with both token and runner identity.
- updated command routing to resolve a target runner by runner hint, container ownership, or hostname.
- updated runner listing shapes to reflect the new identity split.

#### Primary Files

- `apps/runner/src/manifest/detect.ts`
- `packages/shared/src/runner.ts`
- `packages/shared/src/incidents.ts`
- `apps/api/src/db/tokens.ts`
- `apps/api/src/alerts/ingest.ts`
- `apps/api/src/alerts/dedup.ts`
- `apps/api/src/alerts/rate-limit.ts`
- `apps/api/src/alerts/batch-window.ts`
- `apps/api/src/dispatch/dispatcher.ts`
- `apps/api/src/ws/router.ts`
- `apps/api/src/ws/server.ts`
- `apps/api/src/runners/routes.ts`
- `apps/api/src/tests/multi-runner-registry.test.ts`
- `apps/api/src/tests/multi-runner-routing.test.ts`
- `apps/api/src/tests/dispatcher.test.ts`

### 4.6 Problem: Prompt/Tool Layer Still Encoded Incident History

#### Issue

The prompt-building and platform tool layer still included incident-history behavior that belonged to the removed live incident model.

#### Fix

The refactor removed those pathways entirely.

#### Corresponding Changes Introduced

- removed the incident-history block from opening context.
- removed the `get_incident_history` platform tool and schema exposure.
- simplified tests that previously encoded the incident-memory path.

#### Primary Files

- `apps/api/src/investigation/context.ts`
- `apps/api/src/investigation/platform.ts`
- `apps/api/src/investigation/tools.ts`
- `apps/api/src/tests/state-inversion.test.ts`
- `apps/api/src/tests/alert-injection.test.ts`

### 4.7 Problem: Console/UI Flows Still Reflected The Old Model

#### Issue

The console still contained assumptions about token-scoped lookup and old interrupt event names.

#### Fix

The UI was updated to read directly from session-scoped/authenticated endpoints and the new human-input event model.

#### Corresponding Changes Introduced

- updated pending human-input queue fetches.
- updated transcript event handling for the renamed human-input events.
- removed incident-oriented payload assumptions from pending human-input cards.
- aligned tests with the new API surface and event vocabulary.

#### Primary Files

- `apps/console/src/pages/Shell.tsx`
- `apps/console/src/pages/Sessions.tsx`
- `apps/console/src/pages/SessionTranscript.tsx`
- `apps/console/src/pages/ChatInput.tsx`
- `apps/console/src/tests/AppShell.test.tsx`
- `apps/console/src/tests/ChatInput.test.tsx`
- `apps/console/src/tests/SessionTranscript.test.tsx`

## 5. Why The Refactor Failed So Many Times During Implementation

The repeated failures were not because of one unstable code path. They were the expected consequence of changing foundational contracts across multiple layers at once.

### 5.1 Shared-Type Breakages Cascaded Into Multiple Packages

Once the shared contracts changed, downstream code broke in bulk.

Examples:

- `NormalizedAlert` started requiring `runnerId`.
- `SessionMeta` no longer included `token`.
- approval/human-input payloads no longer included `incidentId`.
- websocket event names changed.

This caused a large number of compile failures in API tests, console code, and runner-related fixtures.

### 5.2 Tests Were Encoded Against The Old Architecture, Not Just The Old API

Many tests were not failing because of simple renames. They were asserting the wrong model:

- they expected incident ids to exist in live payloads.
- they read from the incident store even after incident-backed control-plane behavior had been removed.
- they waited for `INTERRUPT` / `INTERRUPT_RESOLVED` even though the runtime now emitted `HUMAN_INPUT_REQUIRED` / `HUMAN_INPUT_RESOLVED`.
- they assumed session state still carried tokens.

Those tests had to be rewritten, not just mechanically updated.

### 5.3 Runtime Failures Came From Test Fixtures That No Longer Matched Real Routing Rules

The most common runtime pattern was: code compiled, but the test setup still reflected the old world.

Examples encountered during this session:

- fake runners were registered in tests without a manifest, but the new routing logic needed `runnerId`, hostname, or container ownership to resolve commands correctly.
- routing tests still waited on old event names.
- a final review pass found that the rules-update route was still passing a token-shaped hint into a runnerId-based command routing API.

### 5.4 The Refactor Removed Parallel Concepts, So Temporary Half-Migrations Broke Easily

This refactor intentionally deleted old concepts rather than keeping aliases. That is the correct architectural direction, but it means the code spends more time in an intermediate “many call sites are wrong at once” state while the migration is in progress.

Specific examples:

- removing live incident behavior while tests still queried incident tables
- replacing `pending_interrupts` with `pending_human_input` while tests still imported the old DB helpers
- swapping command-routing identity from token to runnerId while some routes and tests still passed token-shaped hints

### 5.5 One Fix Surfaced Another Layer Of Drift

A typical cycle during the session looked like this:

1. fix shared types or schema
2. rerun `pnpm typecheck`
3. update tests and fixtures
4. rerun tests
5. discover runtime setup drift or an overlooked route

This is why there were many apparent “new failures.” Most were not new bugs. They were the next exposed layer after the previous mismatch had been corrected.

## 6. Final Review Findings At Session End

At the end of the implementation, a fresh review was performed against the current code rather than relying only on memory of the migration.

### 6.1 Issue Found During Final Review

One concrete behavioral issue was found in `apps/api/src/runners/routes.ts`.

#### Issue

The route that pushes alert rules still passed `request.params.tokenId` as the hint into `sendCommand(...)` even though the command router had been changed to resolve runners by `runnerId` hint, then by container/hostname.

In a multi-runner environment, that was logically wrong and could cause routing failure or misrouting when a direct hint path was needed.

#### Fix

The route was updated to look up the token row and pass the persisted `runnerId` when available.

#### Corresponding Change

- `apps/api/src/runners/routes.ts`

### 6.2 Non-Behavioral Cleanup Found During Final Review

One stale explanatory comment remained in `apps/api/src/investigation/result.ts` referring to an “incident store” mental model that no longer described the implementation.

It was updated so the file comment now matches the transcript/event-based escalation model.

## 7. Validation Completed

The final repository state was validated with:

- `pnpm typecheck`
- `pnpm test`

Observed result at the end of the session:

- API tests passed.
- Console tests passed.
- Runner tests passed.

The console test run still emits existing jsdom `scrollTo()` warnings, but those warnings were not introduced by this refactor and did not cause failure.

## 8. Current State Assessment

### 8.1 What Is Now Clean

- session is the durable operational thread
- pending human input is session-scoped and durable
- critical/non-critical human-input completion is transcript-safe
- incident-backed live control-plane behavior has been removed
- escalation is modeled as transcript evidence plus console event
- session state no longer depends on token coupling
- runner identity is restored as `runnerId` for runtime behavior
- token identity is retained for auth/revocation lifecycle only
- tests and console flows now match the refactored contracts

### 8.2 Remaining Debt

No remaining correctness issue was found in the reviewed refactor seams after the final route fix.

The only meaningful residual debt is documentation debt: source-of-truth documents such as `CONTEXT.md` and some architecture notes were not part of the committed code changes in this session, even though the runtime architecture changed significantly. That is not a code cleanliness blocker, but it is follow-up work worth doing.

## 9. File Inventory By Commit

### 9.1 Commit `ec8c370`

```text
apps/api/src/alerts/ingest.ts
apps/api/src/config/routes.ts
apps/api/src/connect/connect.sh
apps/api/src/runners/routes.ts
apps/api/src/tests/connect-sh.test.ts
apps/api/src/tests/ingest-auth.test.ts
apps/api/src/tests/multi-runner-registry.test.ts
apps/api/src/tests/multi-runner-routing.test.ts
apps/api/src/tests/provider-model-config.test.ts
apps/runner/install/configs/alertmanager.dev.yml
apps/runner/install/configs/alertmanager.yml
apps/runner/src/manifest/detect.ts
nightwatch-v2-review.md
packages/shared/src/runner.ts
```

### 9.2 Commit `ee9db1c`

```text
apps/api/src/alerts/batch-window.ts
apps/api/src/alerts/dedup.ts
apps/api/src/alerts/ingest.ts
apps/api/src/alerts/parsers/alertmanager.ts
apps/api/src/alerts/rate-limit.ts
apps/api/src/approvals/routes.ts
apps/api/src/chat/routes.ts
apps/api/src/db/client.ts
apps/api/src/db/interrupts.ts
apps/api/src/db/sessions.ts
apps/api/src/db/tokens.ts
apps/api/src/dispatch/dispatcher.ts
apps/api/src/human-input/service.ts
apps/api/src/incidents/routes.ts
apps/api/src/index.ts
apps/api/src/investigation/context.ts
apps/api/src/investigation/loop.ts
apps/api/src/investigation/platform.ts
apps/api/src/investigation/result.ts
apps/api/src/investigation/tools.ts
apps/api/src/runners/routes.ts
apps/api/src/session/stream.ts
apps/api/src/sessions/routes.ts
apps/api/src/tests/alert-injection.test.ts
apps/api/src/tests/approval-cycle.test.ts
apps/api/src/tests/approvals-pending.test.ts
apps/api/src/tests/clarification-interrupt.test.ts
apps/api/src/tests/dispatcher.test.ts
apps/api/src/tests/escalation.test.ts
apps/api/src/tests/multi-runner-registry.test.ts
apps/api/src/tests/multi-runner-routing.test.ts
apps/api/src/tests/session-store.test.ts
apps/api/src/tests/state-inversion.test.ts
apps/api/src/tests/token.test.ts
apps/api/src/ws/router.ts
apps/api/src/ws/server.ts
apps/console/src/pages/ChatInput.tsx
apps/console/src/pages/SessionTranscript.tsx
apps/console/src/pages/Sessions.tsx
apps/console/src/pages/Shell.tsx
apps/console/src/tests/AppShell.test.tsx
apps/console/src/tests/ChatInput.test.tsx
apps/console/src/tests/SessionTranscript.test.tsx
apps/runner/src/manifest/detect.ts
packages/shared/src/approvals.ts
packages/shared/src/incidents.ts
packages/shared/src/runner.ts
packages/shared/src/sessions.ts
packages/shared/src/ws.ts
```

## 10. Conclusion

This session did not just rename APIs. It removed an outdated live-control-plane model, simplified the durable operational model around sessions, restored a correct identity split between authentication and runtime routing, and then rewrote the dependent tests and UI surfaces until the repository was green again.

The important engineering outcome is not just that the tests pass. It is that the implementation now matches the intended architecture much more closely:

- sessions are the durable source of truth
- human input is session-scoped
- escalation is transcript/event based
- runner identity is stable and explicit
- tokens are no longer overloaded as machine identity

At the end of the session, the code was validated green and no remaining correctness defect was identified in the refactored seams after final review.