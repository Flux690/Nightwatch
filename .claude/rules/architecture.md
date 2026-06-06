# Architecture Invariants

These rules encode structural decisions that span all phases. They do not change as features are added — they are the load-bearing walls of the system.

- Shared types belong in `packages/shared` only. Never define TypeScript types or interfaces in `apps/`.
- `createProvider()` in `apps/api/src/llm/factory.ts` is the only way to instantiate an LLM client. Never `new AnthropicProvider()` or `new OpenAIProvider()` directly.
- `sendCommand()` in `apps/api/src/ws/router.ts` is the only path from the API to the runner. No code in `apps/api` may write to a runner WebSocket socket directly.
- `REQUIRES_APPROVAL` in `apps/api/src/investigation/tools.ts` is the approval gate. Any new remediation tool must be added to this set before its handler is wired up — never after.
- Every new runner command must have a matching type in `packages/shared/src/ws.ts` before the handler is written in `apps/runner/src/index.ts`.
- Investigation always starts via the BullMQ queue (`apps/api/src/alerts/queue.ts` → `apps/api/src/jobs/worker.ts`). Never invoke the investigation loop directly, bypassing the queue.
- Runner command handlers in `commands/*.ts` must be side-effect-free. Write operations belong exclusively in `commands/remediation.ts`.
