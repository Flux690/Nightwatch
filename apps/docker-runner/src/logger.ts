import pino from "pino";

export const logger = pino({
  level: process.env["NIGHTWARDEN_LOG_LEVEL"] ?? "info",
  serializers: { err: pino.stdSerializers.err },
});
