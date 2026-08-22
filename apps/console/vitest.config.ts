import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    /* This package's own src, resolved here because only the config is certain
       of it: cwd is the repo root under the root run and this package under a
       filtered one, and Vite does not leave import.meta.url a file: URL for a
       test transformed for jsdom. */
    env: {
      CONSOLE_SRC: fileURLToPath(new URL("./src", import.meta.url)),
    },
    // `pnpm test` runs every project at once, so a jsdom test that takes under
    // a second alone can take several under that load. The default 5s budget
    // measures the machine rather than the code.
    testTimeout: 20_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
