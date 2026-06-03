# TypeScript Rules

- Strict mode required in all packages. No exceptions.
- No `any`. Use `unknown` with type narrowing, or proper generics.
- No type assertions (`as SomeType`) without a comment explaining why.
- All async functions must handle errors explicitly. No floating promises.
- Shared types belong in `packages/shared` only. Never duplicate across packages.
- Import order: Node built-ins → external packages → internal packages → relative imports.
- No barrel files (index.ts re-exporting everything). Import directly from the file.
