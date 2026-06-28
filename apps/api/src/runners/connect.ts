import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { requireSession } from "../auth/session.js";
import { extractBearerToken } from "../auth/bearer.js";
import { findRunnerByToken } from "../db/runner.js";
import { generateIngestToken, getIngestTokenPlaintext } from "../db/user.js";

const TEMPLATE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../scripts/connect.sh"),
  "utf8",
);

function buildOrigin(protocol: string, host: string): string {
  return `${protocol}://${host}`;
}

function buildWsUrl(origin: string): string {
  const wsProto = origin.startsWith("https://") ? "wss" : "ws";
  return `${wsProto}://${origin.replace(/^https?:\/\//, "")}/clients/connect`;
}

function buildScript(
  platformUrl: string,
  wsUrl: string,
  token: string,
  serverName: string,
  ingestToken: string,
): string {
  return TEMPLATE.replaceAll("{{PLATFORM_URL}}", platformUrl)
    .replaceAll("{{WS_URL}}", wsUrl)
    .replaceAll("{{NIGHTWATCH_TOKEN}}", token)
    .replaceAll("{{NIGHTWATCH_SERVER_NAME}}", serverName)
    .replaceAll("{{NIGHTWATCH_INGEST_TOKEN}}", ingestToken);
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

      const origin = buildOrigin(
        request.protocol,
        request.headers.host ?? "localhost",
      );
      const wsUrl = buildWsUrl(origin);
      // The first install establishes the fleet-wide ingest token; later installs
      // reuse it so every server's Alertmanager authenticates with one credential.
      const ingestToken = getIngestTokenPlaintext() ?? generateIngestToken();
      const script = buildScript(
        origin,
        wsUrl,
        token,
        record.serverName ?? "",
        ingestToken,
      );

      reply.header("Content-Type", "text/x-shellscript");
      return reply.code(200).send(script);
    },
  );
}
