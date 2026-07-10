import "dotenv/config";
import Fastify from "fastify";
import FastifyWebSocket from "@fastify/websocket";
import { resolveSecretKey } from "./config/secret-key.js";
import { initDb } from "./db/client.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { registerTokenRoutes } from "./auth/token.js";
import { registerIngestCredentialRoutes } from "./auth/ingest-credential.js";
import { registerWsRoutes } from "./ws/server.js";
import { registerConsoleEventRoutes } from "./session/events.js";
import { registerAlertRoutes } from "./alerts/ingest.js";
import { registerAlertTestRoutes } from "./alerts/test-alert.js";
import { registerConfigRoutes } from "./config/routes.js";
import { registerSessionRoutes } from "./session/routes.js";
import { registerRunnerRoutes } from "./runners/routes.js";
import { registerConnectRoutes } from "./runners/connect.js";
import { registerManifestRoutes } from "./runners/manifest.js";
import { registerRemediationRoutes } from "./remediation/routes.js";
import { registerIntegrationRoutes } from "./integrations/routes.js";
import { reapOrphans } from "./sandbox/docker.js";
import { reapEgress } from "./sandbox/egress.js";
import { nightwatchDir } from "./config/paths.js";
import { logger } from "./logger.js";

// Resolve the state directory first so a relative NIGHTWATCH_DIR fails here with
// a clear message, not lazily mid-request.
try {
  logger.info({ dir: nightwatchDir() }, "state directory");
} catch (err) {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

// Explicit SECRET_KEY env var wins; otherwise a key file in the state directory
// is reused or generated on first boot.
process.env["SECRET_KEY"] = resolveSecretKey();

const isDev = process.env["NODE_ENV"] !== "production";

const fastify = Fastify({
  logger: isDev
    ? { transport: { target: "pino-pretty", options: { colorize: true } } }
    : true,
  trustProxy: true,
});

await fastify.register(FastifyWebSocket);

await registerAuthRoutes(fastify);
await registerTokenRoutes(fastify);
await registerIngestCredentialRoutes(fastify);
await registerWsRoutes(fastify);
await registerConsoleEventRoutes(fastify);
await registerAlertRoutes(fastify);
await registerAlertTestRoutes(fastify);
await registerConfigRoutes(fastify);
await registerSessionRoutes(fastify);
await registerRunnerRoutes(fastify);
await registerConnectRoutes(fastify);
await registerManifestRoutes(fastify);
await registerRemediationRoutes(fastify);
await registerIntegrationRoutes(fastify);

fastify.get("/health", async () => ({ status: "ok" }));

const start = async (): Promise<void> => {
  try {
    initDb();
    fastify.log.info("SQLite ready");
    // Sandbox containers are derived state (session map is memory-only), so
    // every labeled survivor of a restart is an orphan. Best-effort: a host
    // without Docker just has no sandboxes to reap.
    void reapOrphans()
      .then((n) => {
        if (n > 0) fastify.log.info(`reaped ${n} orphaned sandbox containers`);
      })
      .catch(() => undefined);
    // The shared egress proxy is derived state too; a fresh one is created on
    // demand with the current allowlist.
    void reapEgress().catch(() => undefined);
    const port = parseInt(process.env["PORT"] ?? "3000", 10);
    const host = process.env["HOST"] ?? "127.0.0.1";
    await fastify.listen({ port, host });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

await start();
