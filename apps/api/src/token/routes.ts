import type { FastifyInstance } from "fastify";
import { mintToken, revokeToken, listTokensMeta } from "../db/tokens.js";
import { closeTokenRunners } from "../ws/router.js";
import { requireSession } from "../auth/session.js";

export async function registerTokenRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // Mint a new deployment token. The plaintext nwr_... value is returned
  // exactly once here and never stored — the DB holds only the SHA-256 hash.
  fastify.post<{ Body: { label?: string } }>(
    "/tokens",
    { preHandler: requireSession },
    async (request, reply) => {
      const label =
        typeof request.body?.label === "string"
          ? request.body.label.trim() || undefined
          : undefined;
      const minted = mintToken(label);
      return reply.code(201).send({
        id: minted.id,
        token: minted.plaintext,
        label: minted.label,
        createdAt: minted.createdAt,
      });
    },
  );

  // List all tokens (active and revoked). No plaintext is ever returned.
  fastify.get("/tokens", { preHandler: requireSession }, async () => ({
    tokens: listTokensMeta(),
  }));

  // Revoke a token by id. Closes any live runner sockets authenticated with
  // it immediately so revocation cuts access without waiting for reconnect.
  fastify.delete<{ Params: { id: string } }>(
    "/tokens/:id",
    { preHandler: requireSession },
    async (request, reply) => {
      const revoked = revokeToken(request.params.id);
      if (!revoked) {
        return reply
          .code(404)
          .send({ error: "token not found or already revoked" });
      }
      closeTokenRunners(request.params.id);
      return reply.code(204).send();
    },
  );
}
