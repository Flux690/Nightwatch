import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import FastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import { logger } from "../logger.js";

// Beside the API bundle in the image; CONSOLE_DIST overrides.
function consoleDist(): string {
  const explicit = process.env["CONSOLE_DIST"];
  if (explicit) return resolve(explicit);
  return join(dirname(fileURLToPath(import.meta.url)), "console");
}

// Same origin as the API, so the console's relative /api calls need no CORS.
// In dev Vite serves it instead, so a missing build is normal.
export async function registerConsoleRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  const root = consoleDist();
  if (!existsSync(join(root, "index.html"))) {
    logger.info({ root }, "no console build found, serving API only");
    return;
  }

  await fastify.register(FastifyStatic, { root, wildcard: false });

  // SPA routes have no file behind them: a deep link or refresh needs index.html.
  fastify.setNotFoundHandler((request, reply) => {
    if (request.method !== "GET" || request.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "not found" });
    }
    return reply.sendFile("index.html");
  });

  logger.info({ root }, "serving console");
}
