import { defineConfig } from "vitest/config";
import { TEST_REDIS_URL } from "./src/tests/test-redis.js";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 20_000,
    hookTimeout: 20_000,
    forceExit: true,
    // Integration tests each start a BullMQ worker on the shared test Redis db.
    // Run files serially so only one worker is alive at a time - parallel workers
    // pull from the same queue and steal each other's jobs (each only has its own
    // runner registered in-process), which fails both tests non-deterministically.
    fileParallelism: false,
    // Point every test worker at a dedicated Redis db before any module reads
    // process.env, so BullMQ and keyspace are isolated from a running dev server.
    env: { REDIS_URL: TEST_REDIS_URL },
    globalSetup: ["./src/tests/global-setup.ts"],
  },
});
