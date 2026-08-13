import "dotenv/config";
import Fastify from "fastify";
import FastifyWebSocket from "@fastify/websocket";
import { resolveSecretKey } from "./env/secret-key.js";
import { initDb } from "./db/client.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { registerTokenRoutes } from "./auth/token.js";
import { registerWsRoutes } from "./ws/server.js";
import { registerConsoleEventRoutes } from "./session/events.js";
import { registerAlertRoutes } from "./alerts/ingest.js";
import { dispatcher } from "./dispatcher.js";
import {
  RECONCILE_TICK_MS,
  reconcileRecovery,
} from "./verification/reconciler.js";
import { registerConfigRoutes } from "./config/routes.js";
import { seedConfigFromEnv } from "./config/store.js";
import { seedIntegrationsFromEnv } from "./integrations/seed.js";
import { registerSessionRoutes } from "./session/routes.js";
import { recoverDeadRuns } from "./session/recover.js";
import { registerRunnerRoutes } from "./runners/routes.js";
import { registerInstallRoutes } from "./runners/install.js";
import { registerIntegrationRoutes } from "./integrations/routes.js";
import { registerConsoleRoutes } from "./console/serve.js";
import { buildAuthHeader } from "./integrations/github.js";
import { reapOrphans } from "./sandbox/docker.js";
import { salvageWorkspaces } from "./sandbox/salvage.js";
import { releaseContainers } from "./sandbox/workspace.js";
import { COMMIT_AUTHOR } from "./agent/tools/repo.js";
import { decrypt } from "./secrets.js";
import { getGitHubIntegration } from "./db/integrations.js";
import {
  nightwardenDir,
  stateDirIsEphemeral,
  workspacesDir,
} from "./env/paths.js";
import { logger } from "./logger.js";

// Resolve the state directory first so a relative NIGHTWARDEN_DIR fails here with
// a clear message, not lazily mid-request.
try {
  const dir = nightwardenDir();
  if (stateDirIsEphemeral(dir)) {
    logger.error(
      { dir },
      "state directory is on the container's writable layer, so the database and secret key would be lost on restart - mount a volume at this path",
    );
    process.exit(1);
  }
  logger.info({ dir }, "state directory");
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

// Under /api so the console owns every other path: /integrations/prometheus
// and /sessions/:id each name both a page and an endpoint.
await fastify.register(
  async (api) => {
    await registerAuthRoutes(api);
    await registerTokenRoutes(api);
    await registerWsRoutes(api);
    await registerConsoleEventRoutes(api);
    await registerAlertRoutes(api);
    await registerConfigRoutes(api);
    await registerSessionRoutes(api);
    await registerRunnerRoutes(api);
    await registerInstallRoutes(api);
    await registerIntegrationRoutes(api);
  },
  { prefix: "/api" },
);

// Outside /api: a container probe is infrastructure, not API surface.
fastify.get("/health", async () => ({ status: "ok" }));

// Last, so it can never shadow an API route.
await registerConsoleRoutes(fastify);

const start = async (): Promise<void> => {
  try {
    initDb();
    fastify.log.info("SQLite ready");
    // Env is a first-boot seed only: this writes the config row on an install
    // that has none, and never again. After that the database is the sole source.
    seedConfigFromEnv();
    // Same first-boot rule for the evidence integrations, so a fresh install can
    // come up fully configured without anyone opening a browser.
    await seedIntegrationsFromEnv();
    // Containers first (kills any still-running writer), then salvage: work orphaned
    // by any death mode is committed and pushed here, before listen() lets a session
    // provision over it. Best-effort throughout.
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
    // Before listen(), so nothing can dispatch into a session this is still
    // deciding about. A run still flagged running was killed with the process.
    const recovered = await recoverDeadRuns();
    if (recovered.failed > 0 || recovered.released > 0) {
      fastify.log.info(
        `interrupted runs: ${recovered.failed} marked failed, ${recovered.resumed} resumed, ${recovered.released} stuck suspensions released`,
      );
    }
    /* Alerts queued when the process died are still queued, and the seats they
       were waiting for were freed by recovery above. Nothing else would notice
       until the next delivery arrived. */
    dispatcher.promoteQueued();
    /* An alert usually clears minutes after the run that fixed it has ended, so
       something has to keep asking. Unref'd: a pending sweep is no reason to
       hold the process open, and the server keeps the loop alive anyway. */
    setInterval(() => {
      void reconcileRecovery().catch((err: unknown) => {
        fastify.log.warn({ err }, "recovery reconciler pass failed");
      });
    }, RECONCILE_TICK_MS).unref();

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
  // Sandbox containers cannot outlive the process that started them: without
  // this they run until the next boot reaps them, holding their reservations.
  // Their checkouts stay, and boot salvage does the git work with time for it.
  releaseContainers()
    .catch((err: unknown) => fastify.log.error(err))
    .finally(() => {
      fastify.close().then(
        () => process.exit(0),
        (err: unknown) => {
          fastify.log.error(err);
          process.exit(1);
        },
      );
    });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
