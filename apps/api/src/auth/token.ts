import type { FastifyInstance } from "fastify";
import { serverNameError } from "@nightwarden/shared";
import { mintTokenRequestSchema } from "@nightwarden/shared/schemas";
import { parseRequest } from "../request-body.js";
import {
  generateRunnerToken,
  deleteRunner,
  listRunnersMeta,
} from "../fleet/runners-store.js";
import { closeRunnerConnections } from "../fleet/connections.js";
import { requireSession } from "./session.js";

export async function registerTokenRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // Generate a new runner token. The plaintext nwr_... value is returned
  // exactly once here and never stored — the DB holds only the SHA-256 hash.
  fastify.post(
    "/tokens",
    { preHandler: requireSession },
    async (request, reply) => {
      // Platform is refused rather than defaulted: a guess throws away what the
      // frontend was told, and the row is what everything else reads.
      const body = parseRequest(mintTokenRequestSchema, request.body ?? {});
      if (!body.ok) return reply.code(400).send({ error: body.error });
      const { platform } = body.data;

      const nameError = serverNameError(body.data.serverName);
      if (nameError) return reply.code(400).send({ error: nameError });
      const serverName = body.data.serverName.trim();

      try {
        const generated = await generateRunnerToken(platform, serverName);
        return reply.code(201).send({
          id: generated.id,
          token: generated.plaintext,
          platform: generated.platform,
          serverName: generated.serverName,
          createdAt: generated.createdAt,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("UNIQUE constraint failed: runner.server_name")) {
          return reply
            .code(409)
            .send({ error: "A runner with that server name already exists" });
        }
        throw err;
      }
    },
  );

  // List all tokens (active and revoked). No plaintext is ever returned.
  fastify.get("/tokens", { preHandler: requireSession }, async () => ({
    tokens: await listRunnersMeta(),
  }));

  // Delete a runner token by id. Closes any live runner sockets authenticated
  // with it immediately so deletion cuts access without waiting for reconnect.
  fastify.delete<{ Params: { id: string } }>(
    "/tokens/:id",
    { preHandler: requireSession },
    async (request, reply) => {
      const deleted = await deleteRunner(request.params.id);
      if (!deleted) {
        return reply.code(404).send({ error: "token not found" });
      }
      closeRunnerConnections(request.params.id);
      return reply.code(204).send();
    },
  );
}
