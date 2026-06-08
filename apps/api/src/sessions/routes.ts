import type { FastifyInstance } from "fastify";
import { sendCommand } from "../ws/router.js";

const QUERY_TIMEOUT_MS = 10_000;

// Read-only session views for the console. Both relay to the runner, which is
// the system of record for transcripts (PRD 4.3 / 10.4).
export async function registerSessionRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get<{ Querystring: { token?: string } }>(
    "/sessions",
    async (request, reply) => {
      const token = request.query.token;
      if (!token) {
        return reply.code(400).send({ error: "token is required" });
      }
      try {
        const sessions = await sendCommand(
          token,
          "get_sessions",
          { token },
          QUERY_TIMEOUT_MS,
        );
        return sessions;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(502).send({ error: msg });
      }
    },
  );

  fastify.get<{ Params: { id: string }; Querystring: { token?: string } }>(
    "/sessions/:id",
    async (request, reply) => {
      const token = request.query.token;
      if (!token) {
        return reply.code(400).send({ error: "token is required" });
      }
      try {
        const messages = await sendCommand(
          token,
          "get_session_messages",
          { sessionId: request.params.id },
          QUERY_TIMEOUT_MS,
        );
        return messages;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(502).send({ error: msg });
      }
    },
  );
}
