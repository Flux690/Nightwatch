import "dotenv/config";
import Fastify from "fastify";
import FastifyWebSocket from "@fastify/websocket";
import { resolveSecretKey } from "./config/secret-key.js";
import { initDb } from "./db/client.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { registerTokenRoutes } from "./auth/token.js";
import { registerWsRoutes } from "./ws/server.js";
import { registerConsoleWsRoutes } from "./ws/console.js";
import { registerAlertRoutes } from "./alerts/ingest.js";
import { registerConfigRoutes } from "./config/routes.js";
import { registerSessionRoutes } from "./session/routes.js";
import { registerRunnerRoutes } from "./runners/routes.js";
import { registerConnectRoutes } from "./runners/connect.js";

// D16: explicit SECRET_KEY env var wins; otherwise a key file beside the
// SQLite database is reused or generated on first boot.
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
await registerWsRoutes(fastify);
await registerConsoleWsRoutes(fastify);
await registerAlertRoutes(fastify);
await registerConfigRoutes(fastify);
await registerSessionRoutes(fastify);
await registerRunnerRoutes(fastify);
await registerConnectRoutes(fastify);

fastify.get("/health", async () => ({ status: "ok" }));

const start = async (): Promise<void> => {
  try {
    initDb();
    fastify.log.info("SQLite ready");
    const port = parseInt(process.env["PORT"] ?? "3000", 10);
    const host = process.env["HOST"] ?? "127.0.0.1";
    await fastify.listen({ port, host });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

await start();
