import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    /* Resolved here because only the config is certain of it: cwd differs
       between the root run and a filtered one, and import.meta.url is not a
       file: URL in a test transformed for jsdom. */
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
