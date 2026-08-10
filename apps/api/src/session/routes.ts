import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type {
  RespondRequest,
  SessionDetail,
  SessionReportResponse,
} from "@nightwarden/shared";
import {
  computeConviction,
  gatedCalls,
  resolveEvidence,
} from "../agent/report.js";
import { hasPendingHumanInput } from "../db/interrupts.js";
import { getReport } from "../db/reports.js";
import { createSession, getSession, deleteSession } from "../db/sessions.js";
import { buildSessionMeta } from "../agent/loop.js";
import { listSessionPage } from "./list.js";
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

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

// A missing parameter takes the default; a nonsensical one is a client bug and
// answers 400 rather than being clamped into a window nobody asked for.
function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return null;
  return value;
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
  // Paginated rather than truncated: a hundredth session used to be the last one
  // the operator could reach, with nothing on screen saying so.
  fastify.get<{
    Querystring: { limit?: string; offset?: string; kind?: string };
  }>("/sessions", { preHandler: requireSession }, async (request, reply) => {
    const limit = parseBoundedInt(
      request.query.limit,
      DEFAULT_PAGE_LIMIT,
      1,
      MAX_PAGE_LIMIT,
    );
    const offset = parseBoundedInt(
      request.query.offset,
      0,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    if (limit === null || offset === null) {
      return reply.code(400).send({ error: "invalid limit or offset" });
    }
    const { kind } = request.query;
    if (kind !== undefined && kind !== "investigation" && kind !== "chat") {
      return reply.code(400).send({ error: "invalid kind" });
    }
    return listSessionPage(limit, offset, kind);
  });

  // The session answers what it is. Returning a bare transcript meant an
  // unknown id came back as `200 []`, which the console drew as a real but
  // empty session.
  fastify.get<{ Params: { id: string } }>(
    "/sessions/:id",
    { preHandler: requireSession },
    async (request, reply) => {
      const session = getSession(request.params.id);
      if (session === undefined) {
        return reply.code(404).send({ error: "unknown session" });
      }
      const response: SessionDetail = {
        sessionId: session.sessionId,
        title: session.title,
        createdAt: session.createdAt,
        investigation: session.investigation,
        running: dispatcher.isSessionRunning(request.params.id),
        alerts: session.alerts,
        transcript: buildTranscript(request.params.id),
      };
      return response;
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/sessions/:id/report",
    { preHandler: requireSession },
    async (request, reply) => {
      const report = getReport(request.params.id);
      if (report === undefined) {
        return reply.code(404).send({ error: "no report for session" });
      }
      // Everything beside `report` is joined here rather than stored, so what
      // the model wrote cannot disagree with what ran, what was quoted, or how
      // well a claim is backed.
      const response: SessionReportResponse = {
        report,
        decisions: gatedCalls(request.params.id),
        evidence: resolveEvidence(request.params.id, report),
        conviction: computeConviction(request.params.id, report),
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

  fastify.post<{ Body: { message?: string; kind?: string } }>(
    "/chat",
    { preHandler: requireSession },
    async (request, reply) => {
      const message = request.body?.message?.trim();
      if (!message) {
        return reply.code(400).send({ error: "message is required" });
      }
      const kind = request.body?.kind ?? "chat";
      if (kind !== "chat" && kind !== "investigation") {
        return reply.code(400).send({ error: "invalid kind" });
      }
      const readiness = checkLLMReadiness();
      if (!readiness.ready) {
        return reply
          .code(503)
          .send({ error: notConfiguredMessage(readiness.missing) });
      }
      const sessionId = randomUUID();
      /* What a session is, is declared here and never again: by an alert, or by
         the operator picking a mode before they typed. Nothing infers it later -
         not the agent mid-conversation, and not the harness from what the run
         happened to record. */
      const investigation = kind === "investigation";
      // The row exists before its id is handed out, so a 202 never names a
      // session the next request cannot fetch. The run's own call is idempotent.
      createSession(
        buildSessionMeta(sessionId, null, message),
        [],
        investigation,
      );
      dispatcher.dispatch({ sessionId, userMessage: message, investigation });
      logger.info({ sessionId, kind }, "session started");
      return reply.code(202).send({ sessionId });
    },
  );

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
      dispatcher.dispatch({ sessionId, seed, userMessage: message });
      logger.info({ sessionId, seeded: seed.length }, "session resumed");
      return reply.code(202).send({ sessionId });
    },
  );
}
