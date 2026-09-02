import { defineConfig } from "vitest/config";

/* One run over every workspace, where six processes each paid their own startup
   and summary block. Each project keeps its own config. */
export default defineConfig({
  test: {
    // Named, not "apps/*": that glob also matches apps/runners and discovers
    // each runner's tests a second time through it.
    projects: ["apps/api", "apps/frontend", "apps/runners/*", "packages/*"],
  },
});
