# Architecture Invariants

These rules encode structural decisions that span all phases (see CONTEXT.md
"Decisions"). They do not change as features are added — they are the
load-bearing walls of the system.

- Shared types belong in `packages/shared` only. Never define TypeScript types
  or interfaces in `apps/`.
- The API's SQLite file is the single system of record (`tokens`, `config`,
  `sessions`, `session_messages`, `pending_human_input`). The runner
  is stateless — its only persistent state is its `runner-id` file. Never add
  durable storage to the runner.
- No Redis, no BullMQ, no Postgres, no ORM. Background work runs on the
  in-process dispatcher; live console events ride the in-process event bus. Do
  not add external infrastructure to solve a single-process problem.
- `createProvider()` in `apps/api/src/llm/factory.ts` is the only way to
  instantiate an LLM client. Never `new AnthropicProvider()` or
  `new OpenAIProvider()` directly.
- `sendCommand()` in `apps/api/src/ws/router.ts` is the only path from the API
  to a runner. No code in `apps/api` may write to a runner socket directly.
- `TOOL_REGISTRY` in `apps/api/src/agent/tools.ts` is the single source of truth
  for every tool. Each entry carries its schema, `access` (`"read" | "write" | "ask"`),
  supported providers, and an `execute()` that hides whether it runs in-process or
  on a runner. The loop gates on `access`: `write` and `ask` suspend via a
  `pending_human_input` row; `read` executes immediately. The loop never awaits a
  human decision in memory, and there is no decision timeout. Resolution = append
  tool_result, delete the row, reseed from the transcript, redispatch. Adding a new
  write tool requires setting `access: "write"` in its registry entry - there is no
  separate set to forget.
- Investigations enter only through the dispatcher (alert, chat, and resume all
  funnel through it). Never invoke the investigation loop directly.
- Every runner command must have a matching type in `packages/shared/src/ws.ts`
  before the handler is written in `apps/runner/src/index.ts`.
- Runner command handlers in `commands/*.ts` must be side-effect-free. Write
  operations belong exclusively in `commands/remediation.ts`.
- Tokens are stored as SHA-256 hashes; plaintext is shown once at mint and never
  appears in logs, identifiers, or URLs we control. Every surface that accepts a
  token (ingest, chat, runner WS, console WS) validates it.
- Sessions have no status column and runs have no state enum. "Awaiting human"
  is derived from `pending_human_input`; "running" from the in-memory active set.
  Do not persist what can be derived.
