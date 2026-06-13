import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { dispatcher } from "../dispatch/dispatcher.js";
import { findTokenByValue } from "../db/tokens.js";
import { getSession, getSessionMessages } from "../db/sessions.js";
import { requireAuth } from "../auth/gate.js";
import { logger } from "../logger.js";
import type { ProviderMessage } from "../llm/types.js";

export async function registerChatRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // Start a new chat session: a human authors the opening message. The loop is
  // session-shaped, so no synthetic alert is constructed - the trigger is "chat"
  // and there is no originating alert.
  fastify.post<{ Params: { token: string }; Body: { message?: string } }>(
    "/chat/:token",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { token } = request.params;
      const message = request.body?.message?.trim();
      if (!message) {
        return reply.code(400).send({ error: "message is required" });
      }

      const tokenRecord = findTokenByValue(token);
      if (!tokenRecord) {
        return reply.code(404).send({ error: "unknown token" });
      }

      const sessionId = randomUUID();
      const accepted = dispatcher.dispatch({
        sessionId,
        token,
        trigger: "chat",
        userMessage: message,
      });
      if (!accepted) {
        return reply
          .code(503)
          .send({ error: "investigation queue full, retry shortly" });
      }
      logger.info(
        { token: token.slice(0, 8), sessionId },
        "chat session started",
      );
      return reply.code(202).send({ sessionId });
    },
  );

  // Resume an existing session: reseed the provider from the locally persisted
  // transcript and continue from the new human message. The session's own
  // trigger and originating alert are recovered from the row inside the loop.
  fastify.post<{
    Params: { id: string };
    Body: { token?: string; message?: string };
  }>(
    "/sessions/:id/messages",
    { preHandler: requireAuth },
    async (request, reply) => {
      const sessionId = request.params.id;
      const token = request.body?.token;
      const message = request.body?.message?.trim();
      if (!token || !message) {
        return reply
          .code(400)
          .send({ error: "token and message are required" });
      }

      const session = getSession(sessionId);
      if (!session || session.token !== token) {
        return reply.code(404).send({ error: "unknown session" });
      }

      const history = getSessionMessages(sessionId);
      const seed: ProviderMessage[] = history.map((m) => ({
        role: m.role,
        content: m.content,
        providerContent: m.providerContent,
      }));

      const accepted = dispatcher.dispatch({
        sessionId,
        token,
        trigger: session.trigger,
        seed,
        userMessage: message,
      });
      if (!accepted) {
        return reply
          .code(503)
          .send({ error: "investigation queue full, retry shortly" });
      }
      logger.info(
        { token: token.slice(0, 8), sessionId, seeded: seed.length },
        "session resumed",
      );
      return reply.code(202).send({ sessionId });
    },
  );
}
