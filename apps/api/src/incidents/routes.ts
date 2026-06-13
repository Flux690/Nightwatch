import type { FastifyInstance } from "fastify";
import {
  getInterruptWithSession,
  deleteInterrupt,
  listAllInterrupts,
} from "../db/interrupts.js";
import type { PendingInterruptWithSession } from "../db/interrupts.js";
import { getSessionMessages } from "../db/sessions.js";
import {
  publishInterruptResolved,
  publishToolCallEnd,
} from "../session/stream.js";
import { dispatcher } from "../dispatch/dispatcher.js";
import { escalate } from "../investigation/result.js";
import { sendCommand } from "../ws/router.js";
import { loadConfig } from "../config/store.js";
import { requireAuth } from "../auth/gate.js";
import { getIncidentById, updateResolutionNote } from "../db/incidents.js";
import { logger } from "../logger.js";
import type { ApprovalRequest, ApprovalResponse } from "@nightwatch/shared";
import type { ProviderMessage, ToolResult } from "../llm/types.js";

interface ApprovalBody {
  resolvedBy?: string;
  comment?: string;
  contextMessage?: string;
}

interface AnswerBody {
  answer: string | string[];
  resolvedBy?: string;
}

function toApprovalRequest(i: PendingInterruptWithSession): ApprovalRequest {
  return {
    id: i.id,
    incidentId: i.id,
    token: i.token,
    toolName: i.toolName,
    toolInput: i.toolInput,
    toolUseId: i.toolUseId,
    status: "pending",
    createdAt: i.createdAt,
  };
}

function buildSeed(sessionId: string): ProviderMessage[] {
  return getSessionMessages(sessionId).map((m) => ({
    role: m.role,
    content: m.content,
    providerContent: m.providerContent,
  }));
}

export async function registerIncidentRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get("/incidents/pending", async () => ({
    pending: listAllInterrupts().map(toApprovalRequest),
  }));

  fastify.post<{ Params: { id: string }; Body: ApprovalBody }>(
    "/incidents/:id/approve",
    { preHandler: requireAuth },
    async (request, reply) => {
      const id = request.params.id;

      const interrupt = getInterruptWithSession(id);
      if (!interrupt) {
        return reply
          .code(409)
          .send({ error: `Interrupt already resolved or not found: ${id}` });
      }

      const { sessionId, token, toolName, toolUseId, completedResults } =
        interrupt;
      const config = loadConfig();

      let gatedResult: ToolResult;
      try {
        const result = await sendCommand(
          token,
          toolName,
          interrupt.toolInput,
          config.toolTimeoutMs,
        );
        gatedResult = {
          tool_use_id: toolUseId,
          content: JSON.stringify(result),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        gatedResult = {
          tool_use_id: toolUseId,
          content: `Error executing ${toolName}: ${msg}`,
          is_error: true,
        };
      }

      // Atomic delete — if row is already gone a concurrent approve beat us.
      if (!deleteInterrupt(id)) {
        return reply
          .code(409)
          .send({ error: "Interrupt already resolved by another request" });
      }

      const resolvedBy = request.body?.resolvedBy ?? "console";
      const resolvedAt = new Date().toISOString();

      publishToolCallEnd({
        sessionId,
        toolUseId,
        result: gatedResult.content,
        isError: gatedResult.is_error,
      });
      publishInterruptResolved({
        incidentId: id,
        toolUseId,
        status: "approved",
        resolvedBy,
        resolvedAt,
      });

      logger.info({ incidentId: id, tool: toolName, resolvedBy }, "approved");

      const resumeToolResults: ToolResult[] = [
        ...completedResults,
        gatedResult,
      ];
      const seed = buildSeed(sessionId);

      dispatcher.dispatch({
        sessionId,
        token,
        trigger: interrupt.sessionTrigger as "alert" | "chat",
        seed,
        resumeToolResults,
      });

      const response: ApprovalResponse = {
        incidentId: id,
        toolUseId,
        status: "approved",
        resolvedBy,
        resolvedAt,
      };
      return reply.code(200).send(response);
    },
  );

  fastify.post<{ Params: { id: string }; Body: ApprovalBody }>(
    "/incidents/:id/reject",
    { preHandler: requireAuth },
    async (request, reply) => {
      const id = request.params.id;

      const interrupt = getInterruptWithSession(id);
      if (!interrupt) {
        return reply
          .code(409)
          .send({ error: `Interrupt already resolved or not found: ${id}` });
      }

      const { sessionId, token, toolName, toolUseId, completedResults } =
        interrupt;

      const gatedResult: ToolResult = {
        tool_use_id: toolUseId,
        content: `Rejected by operator: ${request.body?.comment ?? "no comment"}`,
        is_error: true,
      };

      if (!deleteInterrupt(id)) {
        return reply
          .code(409)
          .send({ error: "Interrupt already resolved by another request" });
      }

      const resolvedBy = request.body?.resolvedBy ?? "console";
      const resolvedAt = new Date().toISOString();

      publishInterruptResolved({
        incidentId: id,
        toolUseId,
        status: "rejected",
        resolvedBy,
        resolvedAt,
      });

      logger.info({ incidentId: id, tool: toolName, resolvedBy }, "rejected");

      const severity = interrupt.originatingAlert?.severity ?? "info";

      if (severity === "critical") {
        const ctx = {
          token,
          containerName:
            interrupt.originatingAlert?.targetIdentifier ?? "unknown",
          alertType: interrupt.originatingAlert?.alertType ?? "unknown",
          firedAt:
            interrupt.originatingAlert?.firedAt ?? new Date().toISOString(),
        };
        escalate(ctx, id, sessionId, `Write action rejected: ${toolName}`);

        const response: ApprovalResponse = {
          incidentId: id,
          toolUseId,
          status: "rejected",
          resolvedBy,
          resolvedAt,
        };
        return reply.code(200).send(response);
      }

      const resumeToolResults: ToolResult[] = [
        ...completedResults,
        gatedResult,
      ];
      const seed = buildSeed(sessionId);

      dispatcher.dispatch({
        sessionId,
        token,
        trigger: interrupt.sessionTrigger as "alert" | "chat",
        seed,
        resumeToolResults,
      });

      const response: ApprovalResponse = {
        incidentId: id,
        toolUseId,
        status: "rejected",
        resolvedBy,
        resolvedAt,
      };
      return reply.code(200).send(response);
    },
  );

  fastify.post<{ Params: { id: string }; Body: ApprovalBody }>(
    "/incidents/:id/add-context",
    { preHandler: requireAuth },
    async (request, reply) => {
      const id = request.params.id;

      const interrupt = getInterruptWithSession(id);
      if (!interrupt) {
        return reply
          .code(409)
          .send({ error: `Interrupt already resolved or not found: ${id}` });
      }

      if (interrupt.kind === "clarification") {
        return reply
          .code(400)
          .send({ error: "Use POST /incidents/:id/answer for clarifications" });
      }

      const { sessionId, token, toolName, toolUseId, completedResults } =
        interrupt;
      const contextMessage =
        request.body?.contextMessage?.trim() ?? request.body?.comment?.trim();
      if (!contextMessage) {
        return reply.code(400).send({ error: "contextMessage is required" });
      }

      const gatedResult: ToolResult = {
        tool_use_id: toolUseId,
        content: `Human added context: ${contextMessage}`,
      };

      if (!deleteInterrupt(id)) {
        return reply
          .code(409)
          .send({ error: "Interrupt already resolved by another request" });
      }

      const resolvedBy = request.body?.resolvedBy ?? "console";
      const resolvedAt = new Date().toISOString();

      publishInterruptResolved({
        incidentId: id,
        toolUseId,
        status: "context_added",
        resolvedBy,
        resolvedAt,
      });

      logger.info(
        { incidentId: id, tool: toolName, resolvedBy },
        "context added",
      );

      const resumeToolResults: ToolResult[] = [
        ...completedResults,
        gatedResult,
      ];
      const seed = buildSeed(sessionId);

      dispatcher.dispatch({
        sessionId,
        token,
        trigger: interrupt.sessionTrigger as "alert" | "chat",
        seed,
        resumeToolResults,
      });

      const response: ApprovalResponse = {
        incidentId: id,
        toolUseId,
        status: "context_added",
        resolvedBy,
        resolvedAt,
      };
      return reply.code(200).send(response);
    },
  );

  fastify.post<{ Params: { id: string }; Body: AnswerBody }>(
    "/incidents/:id/answer",
    { preHandler: requireAuth },
    async (request, reply) => {
      const id = request.params.id;

      const interrupt = getInterruptWithSession(id);
      if (!interrupt) {
        return reply
          .code(409)
          .send({ error: `Interrupt already resolved or not found: ${id}` });
      }

      if (interrupt.kind !== "clarification") {
        return reply
          .code(400)
          .send({ error: "This interrupt is not a clarification" });
      }

      const { sessionId, token, toolName, toolUseId, completedResults } =
        interrupt;
      const rawAnswer = request.body?.answer;
      if (!rawAnswer || (typeof rawAnswer === "string" && !rawAnswer.trim())) {
        return reply.code(400).send({ error: "answer is required" });
      }
      const answerText = Array.isArray(rawAnswer)
        ? rawAnswer.join(", ")
        : rawAnswer;

      const gatedResult: ToolResult = {
        tool_use_id: toolUseId,
        content: answerText,
      };

      if (!deleteInterrupt(id)) {
        return reply
          .code(409)
          .send({ error: "Interrupt already resolved by another request" });
      }

      const resolvedBy = request.body?.resolvedBy ?? "console";
      const resolvedAt = new Date().toISOString();

      publishInterruptResolved({
        incidentId: id,
        toolUseId,
        status: "answered",
        resolvedBy,
        resolvedAt,
      });

      logger.info(
        { incidentId: id, tool: toolName, resolvedBy },
        "clarification answered",
      );

      const resumeToolResults: ToolResult[] = [
        ...completedResults,
        gatedResult,
      ];
      const seed = buildSeed(sessionId);

      dispatcher.dispatch({
        sessionId,
        token,
        trigger: interrupt.sessionTrigger as "alert" | "chat",
        seed,
        resumeToolResults,
      });

      const response: ApprovalResponse = {
        incidentId: id,
        toolUseId,
        status: "answered",
        resolvedBy,
        resolvedAt,
      };
      return reply.code(200).send(response);
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/incidents/:id/status",
    async (request) => {
      const interrupt = getInterruptWithSession(request.params.id);
      return {
        incidentId: request.params.id,
        awaitingApproval: interrupt != null,
        approval: interrupt ? toApprovalRequest(interrupt) : null,
      };
    },
  );

  fastify.post<{
    Params: { id: string };
    Body: { note?: string };
  }>(
    "/incidents/:id/resolve",
    { preHandler: requireAuth },
    async (request, reply) => {
      const incidentId = request.params.id;
      const note = request.body?.note?.trim();
      if (!note) {
        return reply.code(400).send({ error: "note is required" });
      }
      if (!getIncidentById(incidentId)) {
        return reply.code(404).send({ error: "unknown incident" });
      }
      updateResolutionNote(incidentId, note);
      logger.info({ incidentId }, "incident resolved");
      return reply.code(200).send({ incidentId, resolved: true });
    },
  );
}
