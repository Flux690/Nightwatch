import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { dispatcher } from "../dispatch/dispatcher.js";
import { findTokenById, touchLastUsed } from "../db/tokens.js";
import { getSession, getSessionMessages } from "../db/sessions.js";
import { hasPendingInterrupt } from "../db/interrupts.js";
import { requireSession } from "../auth/session.js";
import { logger } from "../logger.js";
import type { ProviderMessage } from "../llm/types.js";

export async function registerChatRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // Start a new chat session. The URL param is the token's UUID (not the
  // plaintext credential — the Console obtains it from GET /tokens).
  fastify.post<{ Params: { tokenId: string }; Body: { message?: string } }>(
    "/chat/:tokenId",
    { preHandler: requireSession },
    async (request, reply) => {
      const { tokenId } = request.params;
      const message = request.body?.message?.trim();
      if (!message) {
        return reply.code(400).send({ error: "message is required" });
      }

      const tokenRecord = findTokenById(tokenId);
      if (!tokenRecord) {
        return reply.code(404).send({ error: "unknown token" });
      }

      touchLastUsed(tokenRecord.id);

      const sessionId = randomUUID();
      const accepted = dispatcher.dispatch({
        sessionId,
        token: tokenRecord.id,
        userMessage: message,
      });
      if (!accepted) {
        return reply
          .code(503)
          .send({ error: "investigation queue full, retry shortly" });
      }
      logger.info(
        { tokenId: tokenRecord.id.slice(0, 8), sessionId },
        "chat session started",
      );
      return reply.code(202).send({ sessionId });
    },
  );

  // Resume an existing session. The body token is the token's UUID.
  fastify.post<{
    Params: { id: string };
    Body: { token?: string; message?: string };
  }>(
    "/sessions/:id/messages",
    { preHandler: requireSession },
    async (request, reply) => {
      const sessionId = request.params.id;
      const tokenId = request.body?.token;
      const message = request.body?.message?.trim();
      if (!tokenId || !message) {
        return reply
          .code(400)
          .send({ error: "token and message are required" });
      }

      const session = getSession(sessionId);
      if (!session || session.token !== tokenId) {
        return reply.code(404).send({ error: "unknown session" });
      }

      if (
        dispatcher.isSessionRunning(sessionId) ||
        hasPendingInterrupt(sessionId)
      ) {
        return reply
          .code(409)
          .send({ error: "session is busy: running or awaiting approval" });
      }

      const tokenRecord = findTokenById(tokenId);
      if (!tokenRecord) {
        return reply.code(404).send({ error: "unknown token" });
      }

      touchLastUsed(tokenRecord.id);

      const history = getSessionMessages(sessionId);
      const seed: ProviderMessage[] = history.map((m) => ({
        role: m.role,
        content: m.content,
        providerContent: m.providerContent,
      }));

      const accepted = dispatcher.dispatch({
        sessionId,
        token: tokenRecord.id,
        seed,
        userMessage: message,
      });
      if (!accepted) {
        return reply
          .code(503)
          .send({ error: "investigation queue full, retry shortly" });
      }
      logger.info(
        { tokenId: tokenRecord.id.slice(0, 8), sessionId, seeded: seed.length },
        "session resumed",
      );
      return reply.code(202).send({ sessionId });
    },
  );
}
