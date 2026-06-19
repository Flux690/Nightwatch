import type { FastifyInstance } from "fastify";
import type { ApprovalRequest, RespondRequest } from "@nightwatch/shared";
import {
  listAllPendingHumanInput,
  type PendingHumanInputWithSession,
} from "../db/interrupts.js";
import { listAllSessions, getSessionMessages } from "../db/sessions.js";
import { requireSession } from "../auth/session.js";
import {
  HumanInputError,
  respondToPendingHumanInput,
} from "../human-input/service.js";

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

// Read-only session views for the console, served from the API's SQLite (state
// inversion): sessions and transcripts are readable even when every runner is
// offline - exactly when the operator needs them.
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
}
