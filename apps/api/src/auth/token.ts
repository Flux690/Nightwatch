import type { FastifyInstance } from "fastify";
import {
  generateRunnerToken,
  deleteRunner,
  listRunnersMeta,
} from "../db/runner.js";
import { closeTokenRunners } from "../ws/router.js";
import { requireSession } from "./session.js";

export async function registerTokenRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // Generate a new runner token. The plaintext nwr_... value is returned
  // exactly once here and never stored — the DB holds only the SHA-256 hash.
  fastify.post<{ Body: { label?: string } }>(
    "/tokens",
    { preHandler: requireSession },
    async (request, reply) => {
      const label =
        typeof request.body?.label === "string"
          ? request.body.label.trim() || undefined
          : undefined;
      const generated = generateRunnerToken(label);
      return reply.code(201).send({
        id: generated.id,
        token: generated.plaintext,
        label: generated.label,
        createdAt: generated.createdAt,
      });
    },
  );

  // List all tokens (active and revoked). No plaintext is ever returned.
  fastify.get("/tokens", { preHandler: requireSession }, async () => ({
    tokens: listRunnersMeta(),
  }));

  // Delete a runner token by id. Closes any live runner sockets authenticated
  // with it immediately so deletion cuts access without waiting for reconnect.
  fastify.delete<{ Params: { id: string } }>(
    "/tokens/:id",
    { preHandler: requireSession },
    async (request, reply) => {
      const deleted = deleteRunner(request.params.id);
      if (!deleted) {
        return reply.code(404).send({ error: "token not found" });
      }
      closeTokenRunners(request.params.id);
      return reply.code(204).send();
    },
  );
}
