import type { FastifyInstance } from "fastify";
import { PLATFORMS, isPlatform, serverNameError } from "@nightwarden/shared";
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
  fastify.post<{
    Body: { platform?: unknown; serverName?: string };
  }>("/tokens", { preHandler: requireSession }, async (request, reply) => {
    // Refused rather than defaulted: a guess here throws away the platform the
    // frontend was told, and the row is what everything else reads.
    const platform = request.body?.platform;
    if (!isPlatform(platform)) {
      return reply.code(400).send({
        error: `platform is required and must be one of: ${PLATFORMS.join(", ")}`,
      });
    }

    // Required, because it is the first segment of every target key this runner
    // will advertise: a nameless runner has nothing to address its services by.
    const rawServerName = request.body?.serverName;
    if (typeof rawServerName !== "string") {
      return reply
        .code(400)
        .send({ error: "serverName is required and must be a string" });
    }
    const nameError = serverNameError(rawServerName);
    if (nameError) return reply.code(400).send({ error: nameError });
    const serverName = rawServerName.trim();

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
  });

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
