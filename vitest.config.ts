import { defineConfig } from "vitest/config";

/* One run over every workspace. Six processes each paid their own startup and
   appended their own GITHUB_STEP_SUMMARY block. Each project keeps its own
   config, so this decides how many processes run them, never what under. */
export default defineConfig({
  test: {
    // Named, not "apps/*": that glob also matches apps/runners and discovers
    // each runner's tests a second time through it.
    projects: ["apps/api", "apps/frontend", "apps/runners/*", "packages/*"],
  },
});
