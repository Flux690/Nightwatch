# Nightwatch v2

## Quick Commands
- Install: `pnpm install`
- Build all: `pnpm build`
- Type-check all: `pnpm typecheck`
- Test: `pnpm test`
- Dev infra: `docker compose -f docker-compose.dev.yml up -d`

## Package Commands
- Runner: `pnpm --filter @nightwatch/runner <cmd>`
- API: `pnpm --filter @nightwatch/api <cmd>`
- Console: `pnpm --filter @nightwatch/console <cmd>`
- Shared: `pnpm --filter @nightwatch/shared <cmd>`

## Rules (hooks enforce these)
- No `any` in TypeScript. Use `unknown` and narrow.
- No `console.log` in source files. Use structured logger.
- Never edit `.env` directly. Never.
- No `git push --force` to main or v2.
- Shared types live in `packages/shared` only.
- Every new WebSocket command needs a matching type in `shared/ws.ts`.

@.claude/rules/typescript.md
@.claude/rules/monorepo.md
@.claude/rules/git.md

## References
- Architecture and decisions: PRD.md
- Phase reference: PLAN.md

## Session protocol
1. Read what SessionStart hook outputs (branch, git state, current phase)
2. Run `pnpm typecheck` to verify baseline if resuming existing code
3. Use Plan Mode (shift+tab) to plan complex tasks before starting
4. Use TodoWrite to track tasks during the session
5. Commit after each completed task
