import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { enqueueJob } from "../alerts/queue.js";
import { sendCommand } from "../ws/router.js";
import { db } from "../db/client.js";
import { requireAuth } from "../auth/gate.js";
import { logger } from "../logger.js";
import type { NormalizedAlert, SessionMessage } from "@nightwatch/shared";
import type { ProviderMessage } from "../llm/types.js";

const RELOAD_TIMEOUT_MS = 10_000;

// A chat/resume turn enters the same loop as an alert; we synthesize a minimal
// alert so the loop's token/incident plumbing works. targetIdentifier/alertType
// are "chat" and severity "info" so the critical-reject-escalate path is off.
function chatAlert(
  token: string,
  sessionId: string,
  message: string,
): NormalizedAlert {
  return {
    sourceAlertId: sessionId,
    token,
    targetIdentifier: "chat",
    alertType: "chat",
    severity: "info",
    firedAt: new Date().toISOString(),
    rawPayload: { message },
  };
}

export async function registerChatRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // Start a new chat session: a human authors the opening message.
  fastify.post<{ Params: { token: string }; Body: { message?: string } }>(
    "/chat/:token",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { token } = request.params;
      const message = request.body?.message?.trim();
      if (!message) {
        return reply.code(400).send({ error: "message is required" });
      }

      const tokenRecord = await db.token.findUnique({
        where: { token },
      });
      if (!tokenRecord) {
        return reply.code(404).send({ error: "unknown token" });
      }

      const sessionId = randomUUID();
      await enqueueJob({
        alert: chatAlert(token, sessionId, message),
        sessionId,
        trigger: "chat",
        userMessage: message,
      });
      logger.info({ token, sessionId }, "chat session started");
      return reply.code(202).send({ sessionId });
    },
  );

  // Resume an existing session: reload its transcript from the runner, seed the
  // provider with it, and continue from the new human message.
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

      let history: SessionMessage[];
      try {
        // get_session_messages returns SessionMessage[]; the WS contract is untyped.
        history = (await sendCommand(
          token,
          "get_session_messages",
          { sessionId },
          RELOAD_TIMEOUT_MS,
        )) as SessionMessage[];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply
          .code(502)
          .send({ error: `failed to load session: ${msg}` });
      }

      const seed: ProviderMessage[] = history.map((m) => ({
        role: m.role,
        content: m.content,
        providerContent: m.providerContent,
      }));

      await enqueueJob({
        alert: chatAlert(token, sessionId, message),
        sessionId,
        trigger: "chat",
        seed,
        userMessage: message,
      });
      logger.info({ token, sessionId, seeded: seed.length }, "session resumed");
      return reply.code(202).send({ sessionId });
    },
  );
}
