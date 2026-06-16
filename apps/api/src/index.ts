import "dotenv/config";
import Fastify from "fastify";
import FastifyWebSocket from "@fastify/websocket";
import { resolveSecretKey } from "./config/secret-key.js";
import { initDb } from "./db/client.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { registerWsRoutes } from "./ws/server.js";
import { registerConsoleWsRoutes } from "./ws/console.js";
import { registerAlertRoutes } from "./alerts/ingest.js";
import { registerIncidentRoutes } from "./incidents/routes.js";
import { registerConfigRoutes } from "./config/routes.js";
import { registerChatRoutes } from "./chat/routes.js";
import { registerSessionRoutes } from "./sessions/routes.js";
import { registerRunnerRoutes } from "./runners/routes.js";
import { registerTokenRoutes } from "./token/routes.js";
import { registerApprovalRoutes } from "./approvals/routes.js";

// Self-provisioning (D16): an explicit env var wins; otherwise a key file
// beside the SQLite database is reused or generated on first boot. No more
// fatal exit - a fresh deploy boots with no manual secret step.
process.env["SECRET_KEY"] = resolveSecretKey();

const isDev = process.env["NODE_ENV"] !== "production";

// Fastify keeps its own pino for HTTP logs; the investigation loop/providers
// use the standalone logger in ./logger.js. Both emit pino JSON to stdout.
// trustProxy honors X-Forwarded-Proto for the session cookie Secure flag.
const fastify = Fastify({
  logger: isDev
    ? { transport: { target: "pino-pretty", options: { colorize: true } } }
    : true,
  trustProxy: true,
});

await fastify.register(FastifyWebSocket);

await registerAuthRoutes(fastify);
await registerWsRoutes(fastify);
await registerConsoleWsRoutes(fastify);
await registerAlertRoutes(fastify);
await registerIncidentRoutes(fastify);
await registerConfigRoutes(fastify);
await registerChatRoutes(fastify);
await registerSessionRoutes(fastify);
await registerRunnerRoutes(fastify);
await registerTokenRoutes(fastify);
await registerApprovalRoutes(fastify);

fastify.get("/health", async () => ({ status: "ok" }));

const start = async (): Promise<void> => {
  try {
    initDb();
    fastify.log.info("SQLite ready");

    // Investigations run on the in-process dispatcher (CONTEXT.md D2); it is a
    // module singleton with no separate worker to boot. No Redis, no BullMQ.
    const port = parseInt(process.env["PORT"] ?? "3000", 10);
    const host = process.env["HOST"] ?? "127.0.0.1";
    await fastify.listen({ port, host });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

await start();
