import "dotenv/config";
import Fastify from "fastify";
import FastifyWebSocket from "@fastify/websocket";
import { db } from "./db/client.js";
import { redis } from "./redis/client.js";
import { registerWsRoutes } from "./ws/server.js";
import { registerConsoleWsRoutes } from "./ws/console.js";
import { registerAlertRoutes } from "./alerts/ingest.js";
import { registerIncidentRoutes } from "./incidents/routes.js";
import { registerConfigRoutes } from "./config/routes.js";
import { registerChatRoutes } from "./chat/routes.js";
import { registerSessionRoutes } from "./sessions/routes.js";
import { registerRunnerRoutes } from "./runners/routes.js";
import { registerTokenRoutes } from "./token/routes.js";
import { registerRelayRoutes } from "./relay/routes.js";
import { registerApprovalRoutes } from "./approvals/routes.js";
import { startWorker } from "./jobs/worker.js";

// Fastify keeps its own pino for HTTP logs; the investigation loop/providers
// use the standalone logger in ./logger.js. Both emit pino JSON to stdout.
const fastify = Fastify({ logger: true });

await fastify.register(FastifyWebSocket);

await registerWsRoutes(fastify);
await registerConsoleWsRoutes(fastify);
await registerAlertRoutes(fastify);
await registerIncidentRoutes(fastify);
await registerConfigRoutes(fastify);
await registerChatRoutes(fastify);
await registerSessionRoutes(fastify);
await registerRunnerRoutes(fastify);
await registerTokenRoutes(fastify);
await registerRelayRoutes(fastify);
await registerApprovalRoutes(fastify);

fastify.get("/health", async () => ({ status: "ok" }));

const start = async (): Promise<void> => {
  try {
    await redis.ping();
    fastify.log.info("Redis connected");

    await db.$connect();
    fastify.log.info("Postgres connected");

    startWorker();
    fastify.log.info("BullMQ worker started");

    const port = parseInt(process.env["PORT"] ?? "3000", 10);
    await fastify.listen({ port, host: "0.0.0.0" });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

await start();
