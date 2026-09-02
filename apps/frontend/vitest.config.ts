import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    /* Only the config is certain of it: cwd differs between a root run and a
       filtered one, and import.meta.url is not a file URL under jsdom. */
    env: {
      FRONTEND_SRC: fileURLToPath(new URL("./src", import.meta.url)),
    },
    // `pnpm test` runs every project at once, so a jsdom test taking under a
    // second alone takes several under that load and outruns the 5s default.
    testTimeout: 20_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
