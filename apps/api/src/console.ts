import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import FastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply } from "fastify";
import { logger } from "./logger.js";

// Beside the API bundle in the image; CONSOLE_DIST overrides.
function consoleDist(): string {
  const explicit = process.env["CONSOLE_DIST"];
  if (explicit) return resolve(explicit);
  return join(dirname(fileURLToPath(import.meta.url)), "console");
}

// Vite content-hashes everything under assets/, so a stale one is unreachable
// rather than wrong. index.html carries the hashes and must never stick.
function setCacheHeaders(reply: FastifyReply, path: string): void {
  const cacheable = path.includes(`${sep}assets${sep}`);
  reply.header(
    "cache-control",
    cacheable ? "public, max-age=31536000, immutable" : "no-cache",
  );
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

  await fastify.register(FastifyStatic, {
    root,
    wildcard: false,
    // The build writes .br beside each text asset, so the megabyte of JS ships
    // compressed without spending CPU on it per request.
    preCompressed: true,
    setHeaders: setCacheHeaders,
  });

  // SPA routes have no file behind them: a deep link or refresh needs index.html.
  fastify.setNotFoundHandler((request, reply) => {
    if (request.method !== "GET" || request.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "not found" });
    }
    return reply.sendFile("index.html");
  });

  logger.info({ root }, "serving console");
}
