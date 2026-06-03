import pino from "pino";

// One logger for the whole API: Fastify uses it for HTTP, and the
// investigation loop/providers use child loggers so every line carries
// its incidentId. The `err` serializer captures stack + SDK status codes,
// which is what makes a 429/timeout legible instead of a silent hang.
export const logger = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  serializers: { err: pino.stdSerializers.err },
});
