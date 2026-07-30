import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 10_000,
    // Vitest 4's default exclude dropped dist/build globs, so the compiled
    // dist/tests/*.test.js would otherwise run a second time alongside src/tests.
    exclude: [...configDefaults.exclude, "dist/**"],
  },
});
