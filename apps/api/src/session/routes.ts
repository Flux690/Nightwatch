import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ApprovalRequest, RespondRequest } from "@nightwatch/shared";
import {
  listAllPendingHumanInput,
  hasPendingHumanInput,
  type PendingHumanInputWithSession,
} from "../db/interrupts.js";
import {
  listAllSessions,
  getSessionMessages,
  getSession,
} from "../db/sessions.js";
import { requireSession } from "../auth/session.js";
import { logger } from "../logger.js";
import { buildSeed } from "./seed.js";
import { HumanInputError, respondToPendingHumanInput } from "./human-input.js";
import { dispatcher } from "../dispatcher.js";

function toApprovalRequest(i: PendingHumanInputWithSession): ApprovalRequest {
  return {
    sessionId: i.sessionId,
    toolName: i.toolName,
    toolInput: i.toolInput,
    toolUseId: i.toolUseId,
    kind: i.kind,
    status: "pending",
    createdAt: i.createdAt,
  };
}

function sendHumanInputError(
  reply: {
    code: (statusCode: number) => {
      send: (body: { error: string }) => unknown;
    };
  },
  error: unknown,
) {
  if (error instanceof HumanInputError) {
    return reply.code(error.statusCode).send({ error: error.message });
  }
  throw error;
}

export async function registerSessionRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get(
    "/sessions/pending-human-input",
    { preHandler: requireSession },
    async () => listAllPendingHumanInput().map(toApprovalRequest),
  );

  fastify.get("/sessions", { preHandler: requireSession }, async () =>
    listAllSessions(),
  );

  fastify.get<{ Params: { id: string } }>(
    "/sessions/:id",
    { preHandler: requireSession },
    async (request) => getSessionMessages(request.params.id),
  );

  fastify.post<{ Params: { id: string }; Body: RespondRequest }>(
    "/sessions/:id/respond",
    { preHandler: requireSession },
    async (request, reply) => {
      try {
        const { decision, text, resolvedBy } = request.body ?? {};
        const response = await respondToPendingHumanInput(
          request.params.id,
          { decision, text },
          resolvedBy,
        );
        return reply.code(200).send(response);
      } catch (error) {
        return sendHumanInputError(reply, error);
      }
    },
  );

  fastify.post<{ Body: { message?: string } }>(
    "/chat",
    { preHandler: requireSession },
    async (request, reply) => {
      const message = request.body?.message?.trim();
      if (!message) {
        return reply.code(400).send({ error: "message is required" });
      }
      const sessionId = randomUUID();
      dispatcher.dispatch({ sessionId, userMessage: message });
      logger.info({ sessionId }, "chat session started");
      return reply.code(202).send({ sessionId });
    },
  );

  fastify.post<{ Params: { id: string }; Body: { message?: string } }>(
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
      dispatcher.dispatch({ sessionId, seed, userMessage: message });
      logger.info({ sessionId, seeded: seed.length }, "session resumed");
      return reply.code(202).send({ sessionId });
    },
  );
}
