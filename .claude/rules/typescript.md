# TypeScript Rules

- Strict mode required in all packages. No exceptions.
- No `any`. Use `unknown` with type narrowing, or proper generics.
- No type assertions (`as SomeType`) without a comment explaining why.
- All async functions must handle errors explicitly. No floating promises.
- Shared types belong in `packages/shared` only. Never duplicate across packages.
- Import order: Node built-ins → external packages → internal packages → relative imports.
- No internal barrel files: don't add a folder `index.ts` to re-export siblings for shorter imports - import directly from the file. A single curated public-API entry per package is fine (e.g. `packages/shared/src/index.ts`); use explicit named re-exports (`export { Foo } from './foo.js'`), never `export *`.
- Comments: `//` for single-line, `/* */` for multi-line. No decorative banners of any kind: no `//────`, `// ===`, `// ***`, `// ─── X ───`, or any line-fill character used to separate sections. Only comment the WHY, never the WHAT. Keep any comment to at most three lines - state the reason and stop; do not narrate the mechanism.
- Never cite untracked docs in comments: no `ADR-XXXX`, no `D1`/`D10`-style decision numbers, no `CONTEXT.md`, no "user story N", no issue numbers. `docs/`, `docs/adr/`, `issues/`, and `CONTEXT.md` are all gitignored - an outside contributor can never resolve the reference, so state the reasoning inline in words instead.
- "Fleet" is singular: it means THE set of currently connected runners, never "fleets" or "every fleet".
