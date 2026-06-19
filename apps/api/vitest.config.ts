import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Vitest 4's default exclude dropped dist/build globs, so the compiled
    // dist/tests/*.test.js would otherwise run a second time alongside src/tests.
    exclude: [...configDefaults.exclude, "dist/**"],
    // Fail a test if a dispatched investigation was swallowed by the dispatcher's
    // catch (logger.error "investigation failed"). setup.ts is not a *.test.ts so
    // the exclude above does not affect it.
    setupFiles: ["./src/tests/setup.ts"],
    // Coverage is a gap-finder, not a CI gate (no thresholds). Run with
    // `pnpm --filter @nightwatch/api test --coverage` and review the critical
    // modules (investigation, dispatch, human-input, alerts).
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/tests/**", "src/**/*.test.ts", "src/index.ts"],
      reporter: ["text-summary", "text"],
    },
  },
});
