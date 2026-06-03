# Monorepo Rules

- Never run `npm install` or `yarn`. Always `pnpm`.
- Package names: @nightwatch/runner, @nightwatch/api, @nightwatch/console, @nightwatch/shared.
- Cross-package imports: always via package name (`@nightwatch/shared`), never via relative paths (`../../packages/shared`).
- To add a dependency: `pnpm --filter @nightwatch/<package> add <dep>`.
- Dev dependencies shared across packages go in root package.json.
- Never import from apps/* in packages/*. Shared only imports from Node built-ins and external packages.
- Before changing packages/shared types: find all importers and update them in the same commit.
- `commands/` inside apps/runner holds execution handlers. `tools/` is reserved for LLM tool schemas in packages/shared.
