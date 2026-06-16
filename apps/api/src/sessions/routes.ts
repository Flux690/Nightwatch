import type { FastifyInstance } from "fastify";
import { listAllSessions, getSessionMessages } from "../db/sessions.js";
import { requireSession } from "../auth/session.js";

// Read-only session views for the console, served from the API's SQLite (state
// inversion): sessions and transcripts are readable even when every runner is
// offline - exactly when the operator needs them.
export async function registerSessionRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get(
    "/sessions",
    { preHandler: requireSession },
    async () => listAllSessions(),
  );

  fastify.get<{ Params: { id: string } }>(
    "/sessions/:id",
    { preHandler: requireSession },
    async (request) => getSessionMessages(request.params.id),
  );
}
