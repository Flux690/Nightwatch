import { defineConfig } from "vitest/config";

/* One run over every workspace, rather than one run per workspace. Six separate
   vitest processes each paid their own startup and transform pass, and each one
   appended its own report to GITHUB_STEP_SUMMARY, so a green CI run printed the
   same summary six times over.

   Each project keeps its own vitest.config.ts, so the console still gets jsdom
   and the api still gets its setup file: this decides how many processes run
   them, never what they run under. Per-package `pnpm --filter <pkg> test` is
   unaffected and still reads the same configs. */
export default defineConfig({
  test: {
    projects: ["apps/*", "packages/*"],
  },
});
