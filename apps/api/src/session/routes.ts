import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { SessionDetail, SessionReportResponse } from "@nightwarden/shared";
import {
  chatRequestSchema,
  sessionMessageRequestSchema,
  sessionPageQuerySchema,
  respondRequestSchema,
} from "@nightwarden/shared/schemas";
import { parseRequest } from "../request-body.js";
import {
  computeConviction,
  gatedCalls,
  resolveEvidence,
} from "../agent/report.js";
import { hasPendingHumanInput } from "./gate-store.js";
import { getRecord } from "./record-store.js";
import {
  createSession,
  deleteSession,
  getSession,
  sessionExists,
} from "./store.js";
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
  // Paginated rather than capped: a cap makes the hundredth session the last
  // one reachable, with nothing on screen saying so.
  fastify.get(
    "/sessions",
    { preHandler: requireSession },
    async (request, reply) => {
      // kind is required: the list is served by one index, and the unfiltered
      // shape it cannot serve was reachable only by omitting this.
      const query = parseRequest(sessionPageQuerySchema, request.query);
      if (!query.ok) return reply.code(400).send({ error: query.error });
      const { limit, offset, kind } = query.data;
      return await listSessionPage(limit, offset, kind);
    },
  );

  // The session answers what it is. A bare transcript returned `200 []` for an
  // unknown id, which the frontend drew as a real but empty session.
  fastify.get<{ Params: { id: string } }>(
    "/sessions/:id",
    { preHandler: requireSession },
    async (request, reply) => {
      const session = await getSession(request.params.id);
      if (session === undefined) {
        return reply.code(404).send({ error: "unknown session" });
      }
      const response: SessionDetail = {
        sessionId: session.sessionId,
        title: session.title,
        createdAt: session.createdAt,
        lastActivityAt: session.lastActivityAt,
        investigation: session.investigation,
        running: await dispatcher.isSessionRunning(request.params.id),
        alerts: session.alerts,
        transcript: await buildTranscript(request.params.id),
      };
      return response;
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/sessions/:id/report",
    { preHandler: requireSession },
    async (request, reply) => {
      const record = await getRecord(request.params.id);
      if (record === undefined) {
        return reply.code(404).send({ error: "no report for session" });
      }
      // Everything beside `record` is joined rather than stored, so what the
      // model wrote cannot disagree with what ran or how well a claim is backed.
      const response: SessionReportResponse = {
        record,
        decisions: await gatedCalls(request.params.id),
        evidence: await resolveEvidence(request.params.id, record),
        conviction: await computeConviction(request.params.id, record),
      };
      return response;
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    "/sessions/:id",
    { preHandler: requireSession },
    async (request, reply) => {
      const sessionId = request.params.id;
      if (await dispatcher.isSessionRunning(sessionId)) {
        return reply
          .code(409)
          .send({ error: "session is running: stop it before deleting" });
      }
      // Awaited, because a truthful 204 beats a fast one. Left behind, the idle
      // sweep would push work for a session the user asked to remove.
      await teardown(sessionId, "deleted");
      await deleteSession(sessionId);
      // The one way a seat frees without a run ending, so nothing else would
      // notice and a waiting alert would sit until the next delivery.
      await publishQueueChanged();
      await dispatcher.promoteQueued();
      return reply.code(204).send();
    },
  );

  // No body: the sentence is the server's, kept beside the other prompts
  // rather than composed by whoever pressed the button.
  fastify.post<{ Params: { id: string } }>(
    "/sessions/:id/report/retry",
    { preHandler: requireSession },
    async (request, reply) => {
      const sessionId = request.params.id;
      const session = await getSession(sessionId);
      if (session === undefined) {
        return reply.code(404).send({ error: "unknown session" });
      }
      if (!session.investigation) {
        return reply
          .code(409)
          .send({ error: "a chat keeps no record to write up" });
      }
      if (await hasPendingHumanInput(sessionId)) {
        return reply
          .code(409)
          .send({ error: "session is busy: awaiting approval" });
      }
      const started = await dispatcher.dispatch({
        sessionId,
        seed: await buildSeed(sessionId),
        systemReminder: REPORT_RETRY_REQUEST,
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

  fastify.post<{ Params: { id: string } }>(
    "/sessions/:id/respond",
    { preHandler: requireSession },
    async (request, reply) => {
      const body = parseRequest(respondRequestSchema, request.body ?? {});
      if (!body.ok) return reply.code(400).send({ error: body.error });
      try {
        const response = await respondToPendingHumanInput(
          request.params.id,
          body.data,
        );
        return reply.code(200).send(response);
      } catch (error) {
        return sendHumanInputError(reply, error);
      }
    },
  );

  fastify.post(
    "/chat",
    { preHandler: requireSession },
    async (request, reply) => {
      // The schema admits only kind "chat": an investigation is a session with a
      // falsifiable condition attached, and only an alert carries one.
      const body = parseRequest(chatRequestSchema, request.body ?? {});
      if (!body.ok) return reply.code(400).send({ error: body.error });
      const { message } = body.data;
      const readiness = await checkLLMReadiness();
      if (!readiness.ready) {
        return reply
          .code(503)
          .send({ error: notConfiguredMessage(readiness.missing) });
      }
      // Refused rather than queued, because someone is watching and would get
      // a spinner with no end. A resume already holds its seat.
      if (!(await hasSeat(false))) {
        return reply.code(503).send({
          error: `You've reached the limit of ${await seatLimit(false)} simultaneous conversations. Wait for one to finish before starting another.`,
        });
      }
      const sessionId = randomUUID();
      // The row exists before its id is handed out, so a 202 never names a
      // session the next request cannot fetch. The run's own call is idempotent.
      await createSession(buildSessionMeta(sessionId, null, message), false);
      await dispatcher.dispatch({
        sessionId,
        userMessage: message,
        investigation: false,
      });
      logger.info({ sessionId }, "session started");
      return reply.code(202).send({ sessionId });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/sessions/:id/messages",
    { preHandler: requireSession },
    async (request, reply) => {
      const sessionId = request.params.id;
      const body = parseRequest(
        sessionMessageRequestSchema,
        request.body ?? {},
      );
      if (!body.ok) return reply.code(400).send({ error: body.error });
      const { message } = body.data;
      if (!(await sessionExists(sessionId))) {
        return reply.code(404).send({ error: "unknown session" });
      }
      // Parked on a human rather than racing: the answer comes from the respond
      // route, so this is refused before anything tries to claim the session.
      if (await hasPendingHumanInput(sessionId)) {
        return reply
          .code(409)
          .send({ error: "session is busy: awaiting approval" });
      }
      const seed = await buildSeed(sessionId);
      // The claim inside dispatch decides it, not a check up here: the loser is
      // told rather than colliding on the transcript's primary key.
      if (
        !(await dispatcher.dispatch({ sessionId, seed, userMessage: message }))
      ) {
        return reply
          .code(409)
          .send({ error: "session is busy: a run is already in flight" });
      }
      logger.info({ sessionId, seeded: seed.length }, "session resumed");
      return reply.code(202).send({ sessionId });
    },
  );
}
