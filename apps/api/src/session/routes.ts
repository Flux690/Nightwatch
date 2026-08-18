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
import {
  createSession,
  deleteSession,
  getSession,
  sessionExists,
} from "../db/sessions.js";
import { buildSessionMeta } from "../agent/loop.js";
import { REPORT_RETRY_REQUEST } from "../agent/prompts/report.js";
import { listSessionPage } from "./list.js";
import { buildTranscript } from "./transcript.js";
import { requireSession } from "../auth/session.js";
import { logger } from "../logger.js";
import { buildSeed } from "./seed.js";
import { teardown } from "../sandbox/workspace.js";
import { HumanInputError, respondToPendingHumanInput } from "./human-input.js";
import { dispatcher } from "../dispatcher.js";
import { hasSeat, seatLimit } from "../run-pool.js";
import { publishQueueChanged } from "./stream.js";
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
  // the user could reach, with nothing on screen saying so.
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
        lastActivityAt: session.lastActivityAt,
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
      /* Left behind, the container keeps running and the idle sweep pushes to the
         user's repository for a session they deleted. Awaited, not fired and
         forgotten: a delete is rare, and a truthful 204 beats a fast one. */
      await teardown(sessionId, "deleted");
      deleteSession(sessionId);
      /* A suspended session holds a seat, and deleting it is the one way that
         seat is freed without a run ending - so nothing else would notice, and
         a waiting alert would sit there until the next delivery arrived. */
      publishQueueChanged();
      dispatcher.promoteQueued();
      return reply.code(204).send();
    },
  );

  /* No body: the sentence sent to the model is the server's, kept beside the
     other prompts rather than composed by whoever pressed the button. The same
     loop and the same tool, entered again - not a second way to make a report. */
  fastify.post<{ Params: { id: string } }>(
    "/sessions/:id/report/retry",
    { preHandler: requireSession },
    async (request, reply) => {
      const sessionId = request.params.id;
      const session = getSession(sessionId);
      if (session === undefined) {
        return reply.code(404).send({ error: "unknown session" });
      }
      if (!session.investigation) {
        return reply
          .code(409)
          .send({ error: "a chat keeps no record to write up" });
      }
      if (hasPendingHumanInput(sessionId)) {
        return reply
          .code(409)
          .send({ error: "session is busy: awaiting approval" });
      }
      const started = dispatcher.dispatch({
        sessionId,
        seed: buildSeed(sessionId),
        harnessMessage: REPORT_RETRY_REQUEST,
      });
      if (!started) {
        return reply
          .code(409)
          .send({ error: "session is busy: a run is already in flight" });
      }
      logger.info({ sessionId }, "writing the report again");
      return reply.code(202).send({ sessionId });
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
        const { decision, text } = request.body ?? {};
        const response = await respondToPendingHumanInput(request.params.id, {
          decision,
          text,
        });
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
      // Declared here and never again. Nothing infers it later - not the agent
      // mid-conversation, and not the harness from what the run recorded.
      const investigation = kind === "investigation";
      /* Refused rather than queued, because someone is watching: an alert was
         answered 200 and has nobody to tell, a person would see a spinner with no
         end. Only new work is checked; a resume already holds its seat. */
      if (!hasSeat(investigation)) {
        return reply.code(503).send({
          error: investigation
            ? `All ${seatLimit(true)} investigation slots are busy. Wait for one to finish, or raise the limit in Settings.`
            : `You've reached the limit of ${seatLimit(false)} simultaneous conversations. Wait for one to finish before starting another.`,
        });
      }
      const sessionId = randomUUID();
      // The row exists before its id is handed out, so a 202 never names a
      // session the next request cannot fetch. The run's own call is idempotent.
      createSession(buildSessionMeta(sessionId, null, message), investigation);
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
      if (!sessionExists(sessionId)) {
        return reply.code(404).send({ error: "unknown session" });
      }
      // Parked on a human rather than racing: the answer comes from the respond
      // route, so this is refused before anything tries to claim the session.
      if (hasPendingHumanInput(sessionId)) {
        return reply
          .code(409)
          .send({ error: "session is busy: awaiting approval" });
      }
      const seed = buildSeed(sessionId);
      // The claim inside dispatch decides it, not a check up here: the loser is
      // told rather than colliding on the transcript's primary key.
      if (!dispatcher.dispatch({ sessionId, seed, userMessage: message })) {
        return reply
          .code(409)
          .send({ error: "session is busy: a run is already in flight" });
      }
      logger.info({ sessionId, seeded: seed.length }, "session resumed");
      return reply.code(202).send({ sessionId });
    },
  );
}
