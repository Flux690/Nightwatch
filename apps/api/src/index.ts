import "dotenv/config";
import Fastify from "fastify";
import FastifyWebSocket from "@fastify/websocket";
import { db } from "./db/client.js";
import { redis } from "./redis/client.js";
import { registerWsRoutes } from "./ws/server.js";
import { registerAlertRoutes } from "./alerts/ingest.js";
import { startWorker } from "./jobs/worker.js";

const fastify = Fastify({ logger: true });

await fastify.register(FastifyWebSocket);

await registerWsRoutes(fastify);
await registerAlertRoutes(fastify);

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
