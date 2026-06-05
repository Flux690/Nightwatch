# TypeScript Rules

- Strict mode required in all packages. No exceptions.
- No `any`. Use `unknown` with type narrowing, or proper generics.
- No type assertions (`as SomeType`) without a comment explaining why.
- All async functions must handle errors explicitly. No floating promises.
- Shared types belong in `packages/shared` only. Never duplicate across packages.
- Import order: Node built-ins → external packages → internal packages → relative imports.
- No internal barrel files: don't add a folder `index.ts` to re-export siblings for shorter imports - import directly from the file. A single curated public-API entry per package is fine (e.g. `packages/shared/src/index.ts`); use explicit named re-exports (`export { Foo } from './foo.js'`), never `export *`.
- Comments: `//` for single-line, `/* */` for multi-line. No decorative banners (`//────`, `// ===`, `// ***`). Only comment the WHY, never the WHAT.
