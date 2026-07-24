import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { requireSession } from "../auth/session.js";
import { extractBearerToken } from "../auth/bearer.js";
import { findRunnerByToken } from "../db/runner.js";

const TEMPLATE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../scripts/connect.sh"),
  "utf8",
);

function buildWsUrl(protocol: string, host: string): string {
  const wsProto = protocol === "https" ? "wss" : "ws";
  return `${wsProto}://${host}/clients/connect`;
}

function buildScript(wsUrl: string, token: string, serverName: string): string {
  return TEMPLATE.replaceAll("{{WS_URL}}", wsUrl)
    .replaceAll("{{NIGHTWARDEN_TOKEN}}", token)
    .replaceAll("{{NIGHTWARDEN_SERVER_NAME}}", serverName);
}

export async function registerConnectRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get(
    "/connect.sh",
    { preHandler: requireSession },
    async (request, reply) => {
      const token = extractBearerToken(request.headers.authorization);
      if (!token) {
        return reply.code(400).send({
          error: "runner token required in Authorization: Bearer header",
        });
      }

      const record = findRunnerByToken(token);
      if (!record) {
        return reply.code(404).send({ error: "token not found" });
      }

      const wsUrl = buildWsUrl(
        request.protocol,
        request.headers.host ?? "localhost",
      );
      const script = buildScript(wsUrl, token, record.serverName ?? "");

      reply.header("Content-Type", "text/x-shellscript");
      return reply.code(200).send(script);
    },
  );
}
