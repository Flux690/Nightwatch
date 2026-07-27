import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type {
  RespondRequest,
  RunMode,
  SessionReportResponse,
  TranscriptItem,
} from "@nightwarden/shared";
import { hasPendingHumanInput } from "../db/interrupts.js";
import { getReport } from "../db/reports.js";
import {
  listRemediationActionsForSession,
  toActionRecord,
} from "../db/remediation-actions.js";
import { getSession, deleteSession } from "../db/sessions.js";
import { listSessionRows } from "./list.js";
import { buildTranscript } from "./transcript.js";
import { requireSession } from "../auth/session.js";
import { logger } from "../logger.js";
import { buildSeed } from "./seed.js";
import { HumanInputError, respondToPendingHumanInput } from "./human-input.js";
import { dispatcher } from "../dispatcher.js";
import {
  checkLLMReadiness,
  notConfiguredMessage,
} from "../config/readiness.js";

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
  fastify.get("/sessions", { preHandler: requireSession }, async () =>
    listSessionRows(),
  );

  fastify.get<{ Params: { id: string } }>(
    "/sessions/:id",
    { preHandler: requireSession },
    async (request): Promise<TranscriptItem[]> =>
      buildTranscript(request.params.id),
  );

  fastify.get<{ Params: { id: string } }>(
    "/sessions/:id/report",
    { preHandler: requireSession },
    async (request, reply) => {
      const report = getReport(request.params.id);
      if (report === undefined) {
        return reply.code(404).send({ error: "no report for session" });
      }
      // Actions come from the executor's own log, never from the report the
      // model wrote, so "what ran" cannot disagree with what actually ran.
      const response: SessionReportResponse = {
        report,
        actions: listRemediationActionsForSession(request.params.id).map(
          toActionRecord,
        ),
      };
      return response;
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    "/sessions/:id",
    { preHandler: requireSession },
    async (request, reply) => {
      const sessionId = request.params.id;
      if (dispatcher.isSessionRunning(sessionId)) {
        return reply
          .code(409)
          .send({ error: "session is running: stop it before deleting" });
      }
      deleteSession(sessionId);
      return reply.code(204).send();
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/sessions/:id/stop",
    { preHandler: requireSession },
    async (request, reply) => {
      const stopped = dispatcher.stop(request.params.id);
      if (!stopped) {
        return reply.code(409).send({ error: "session is not running" });
      }
      return reply.code(200).send({ stopped: true });
    },
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

  fastify.post<{ Body: { message?: string; mode?: RunMode } }>(
    "/chat",
    { preHandler: requireSession },
    async (request, reply) => {
      const message = request.body?.message?.trim();
      if (!message) {
        return reply.code(400).send({ error: "message is required" });
      }
      const readiness = checkLLMReadiness();
      if (!readiness.ready) {
        return reply
          .code(503)
          .send({ error: notConfiguredMessage(readiness.missing) });
      }
      const sessionId = randomUUID();
      // A new chat is a plain ask unless the composer explicitly investigates.
      const mode: RunMode =
        request.body?.mode === "investigate" ? "investigate" : "ask";
      dispatcher.dispatch({ sessionId, userMessage: message, mode });
      logger.info({ sessionId, mode }, "chat session started");
      return reply.code(202).send({ sessionId });
    },
  );

  fastify.post<{
    Params: { id: string };
    Body: { message?: string; mode?: RunMode };
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
      // Only escalation is accepted on a follow-up; otherwise the loop derives
      // the mode (one-way ratchet - an investigation can never demote to ask).
      dispatcher.dispatch({
        sessionId,
        seed,
        userMessage: message,
        ...(request.body?.mode === "investigate" && {
          mode: "investigate" as const,
        }),
      });
      logger.info({ sessionId, seeded: seed.length }, "session resumed");
      return reply.code(202).send({ sessionId });
    },
  );
}
