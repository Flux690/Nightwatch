import "dotenv/config";
import Fastify from "fastify";
import FastifyWebSocket from "@fastify/websocket";
import { resolveSecretKey } from "./config/secret-key.js";
import { initDb } from "./db/client.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { registerTokenRoutes } from "./auth/token.js";
import { registerWsRoutes } from "./ws/server.js";
import { registerConsoleEventRoutes } from "./session/events.js";
import { registerAlertRoutes } from "./alerts/ingest.js";
import { registerAlertTestRoutes } from "./alerts/test-alert.js";
import { registerConfigRoutes } from "./config/routes.js";
import { registerConfigHealthRoutes } from "./config/health.js";
import { registerSessionRoutes } from "./session/routes.js";
import { registerRunnerRoutes } from "./runners/routes.js";
import { registerConnectRoutes } from "./runners/connect.js";
import { registerManifestRoutes } from "./runners/manifest.js";
import { registerRemediationRoutes } from "./remediation/routes.js";
import { registerIntegrationRoutes } from "./integrations/routes.js";
import { buildAuthHeader } from "./integrations/github.js";
import { reapOrphans } from "./sandbox/docker.js";
import { salvageWorkspaces } from "./sandbox/salvage.js";
import { COMMIT_AUTHOR } from "./agent/tools/repo.js";
import { decrypt } from "./config/crypto.js";
import { getGitHubIntegration } from "./db/integrations.js";
import { nightwatchDir, workspacesDir } from "./config/paths.js";
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
  // Long-lived console SSE streams would otherwise hold close() open forever.
  forceCloseConnections: true,
});

await fastify.register(FastifyWebSocket);

await registerAuthRoutes(fastify);
await registerTokenRoutes(fastify);
await registerWsRoutes(fastify);
await registerConsoleEventRoutes(fastify);
await registerAlertRoutes(fastify);
await registerAlertTestRoutes(fastify);
await registerConfigRoutes(fastify);
await registerConfigHealthRoutes(fastify);
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
    // Containers first (kills any still-running writer), then salvage: the
    // checkout is a host bind mount, so work orphaned by any death mode is
    // committed and pushed here, before listen() lets a session provision over
    // it. Best-effort throughout - a host without Docker has nothing to reap.
    try {
      const reaped = await reapOrphans();
      if (reaped > 0) {
        fastify.log.info(`reaped ${reaped} orphaned sandbox containers`);
      }
    } catch {
      // Docker unreachable - salvage below still works, it is host-side git.
    }
    const salvaged = await salvageWorkspaces({
      workspacesDir: workspacesDir(),
      authHeader: () => {
        const row = getGitHubIntegration();
        if (row === null) {
          return Promise.reject(
            new Error("GitHub integration is not configured"),
          );
        }
        return Promise.resolve(buildAuthHeader(decrypt(row.tokenEncrypted)));
      },
      commitAuthor: COMMIT_AUTHOR,
      log: logger,
    });
    if (salvaged.pushed > 0 || salvaged.kept > 0) {
      fastify.log.info(
        `workspace salvage: ${salvaged.pushed} pushed, ${salvaged.kept} kept for manual recovery`,
      );
    }
    const port = parseInt(process.env["PORT"] ?? "3000", 10);
    const host = process.env["HOST"] ?? "127.0.0.1";
    await fastify.listen({ port, host });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

await start();

// Without handlers the open SSE/WS connections keep the event loop alive on
// Ctrl+C until tsx force-kills the process. Exit 0: a signal exit is a normal
// exit here, so pnpm doesn't report a failed script.
function shutdown(signal: NodeJS.Signals): void {
  fastify.log.info({ signal }, "shutting down");
  const failsafe = setTimeout(() => process.exit(1), 5000);
  failsafe.unref();
  fastify.close().then(
    () => process.exit(0),
    (err: unknown) => {
      fastify.log.error(err);
      process.exit(1);
    },
  );
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
