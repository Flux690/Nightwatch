import type { FastifyInstance } from "fastify";
import { requireSession } from "../auth/session.js";
import { extractBearerToken } from "../auth/bearer.js";
import { findRunnerByToken } from "../db/runner.js";
import { CONNECT_SCRIPT_TEMPLATE as TEMPLATE } from "./connect-script.js";
import { RUNNER_IMAGE } from "./image.js";
import { publicWsUrl } from "../env/public-url.js";

function buildScript(wsUrl: string, token: string): string {
  return TEMPLATE.replaceAll("{{RUNNER_IMAGE}}", RUNNER_IMAGE)
    .replaceAll("{{WS_URL}}", wsUrl)
    .replaceAll("{{NIGHTWARDEN_TOKEN}}", token);
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

      const wsUrl = publicWsUrl(request, "/api/clients/connect");
      const script = buildScript(wsUrl, token);

      reply.header("Content-Type", "text/x-shellscript");
      return reply.code(200).send(script);
    },
  );
}
