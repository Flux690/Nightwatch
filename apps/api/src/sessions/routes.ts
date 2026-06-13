import type { FastifyInstance } from "fastify";
import { listSessions, getSessionMessages } from "../db/sessions.js";

// Read-only session views for the console, served from the API's SQLite (state
// inversion): sessions and transcripts are readable even when every runner is
// offline - exactly when the operator needs them.
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
      return listSessions(token);
    },
  );

  fastify.get<{ Params: { id: string } }>("/sessions/:id", async (request) =>
    getSessionMessages(request.params.id),
  );
}
