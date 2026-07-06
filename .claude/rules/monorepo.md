# Monorepo Rules

- Never run `npm install` or `yarn`. Always `pnpm`.
- Package names: @nightwatch/runner, @nightwatch/api, @nightwatch/console, @nightwatch/shared.
- Cross-package imports: always via package name (`@nightwatch/shared`), never via relative paths (`../../packages/shared`).
- To add a dependency: `pnpm --filter @nightwatch/<package> add <dep>`.
- Dev dependencies shared across packages go in root package.json.
- Never import from apps/* in packages/*. Shared only imports from Node built-ins and external packages.
- Before changing packages/shared types: find all importers and update them in the same commit.
- `commands/` inside apps/runner holds provider-agnostic dispatch plus host/file handlers; provider-specific execution lives in `apps/runner/src/docker/` and `apps/runner/src/kubernetes/`. LLM tool schemas (name, description, JSON schema, `access` gating) live in `apps/api/src/agent/tools/` - per-domain files (`observability.ts`, `remediation.ts`, `interrupts.ts`) assembled into the single `TOOL_REGISTRY` in `toolset.ts`; `packages/shared/src/tools.ts` holds only the tool input/output payload types shared between API and runner.
- `@nightwatch/shared` is consumed via its built output (`package.json` -> `"types": "./dist/index.d.ts"`), and `pnpm typecheck` does NOT rebuild shared first. After any edit to `packages/shared/src/*`, run `pnpm --filter @nightwatch/shared build` before trusting typecheck/test in `apps/*` - otherwise they validate against a stale `dist/` and either pass falsely or throw phantom "has no exported member" errors. Order: rebuild shared, then typecheck, then test. Note also that `git merge-tree` reporting a clean merge does not mean semantically green (e.g. a rename in one file plus references in another can auto-merge cleanly but break the build) - always rerun the feedback loops after a merge.
