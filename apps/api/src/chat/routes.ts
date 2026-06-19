import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { dispatcher } from "../dispatch/dispatcher.js";
import { getSession } from "../db/sessions.js";
import { hasPendingHumanInput } from "../db/interrupts.js";
import { requireSession } from "../auth/session.js";
import { logger } from "../logger.js";
import { buildSeed } from "../session/seed.js";

export async function registerChatRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // Start a new chat session. Authenticated by the owner session cookie; no
  // runner token in the path — the agent reaches the whole flat fleet via the
  // registry (D14).
  fastify.post<{ Body: { message?: string } }>(
    "/chat",
    { preHandler: requireSession },
    async (request, reply) => {
      const message = request.body?.message?.trim();
      if (!message) {
        return reply.code(400).send({ error: "message is required" });
      }

      const sessionId = randomUUID();
      dispatcher.dispatch({
        sessionId,
        userMessage: message,
      });
      logger.info({ sessionId }, "chat session started");
      return reply.code(202).send({ sessionId });
    },
  );

  // Resume an existing session addressed by its uuid.
  fastify.post<{
    Params: { id: string };
    Body: { message?: string };
  }>(
    "/sessions/:id/messages",
    { preHandler: requireSession },
    async (request, reply) => {
      const sessionId = request.params.id;
      const message = request.body?.message?.trim();
      if (!message) {
        return reply.code(400).send({ error: "message is required" });
      }

      const session = getSession(sessionId);
      if (!session) {
        return reply.code(404).send({ error: "unknown session" });
      }

      if (
        dispatcher.isSessionRunning(sessionId) ||
        hasPendingHumanInput(sessionId)
      ) {
        return reply
          .code(409)
          .send({ error: "session is busy: running or awaiting approval" });
      }

      const seed = buildSeed(sessionId);
      dispatcher.dispatch({
        sessionId,
        seed,
        userMessage: message,
      });
      logger.info({ sessionId, seeded: seed.length }, "session resumed");
      return reply.code(202).send({ sessionId });
    },
  );
}
