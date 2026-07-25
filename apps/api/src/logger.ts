import pino from "pino";

const isDev = process.env["NODE_ENV"] !== "production";

// err serializer captures stack + SDK status codes so LLM 429/timeout is legible, not a silent hang
export const logger = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  serializers: { err: pino.stdSerializers.err },
  // Pretty output is for a terminal. In production this has to be the JSON
  // Fastify already emits, or a collector can parse only half the process.
  ...(isDev
    ? { transport: { target: "pino-pretty", options: { colorize: true } } }
    : {}),
});
