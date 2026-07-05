import type { FastifyInstance } from "fastify";
import {
  ensureIngestToken,
  generateIngestToken,
  getIngestTokenHash,
  getIngestTokenPlaintext,
} from "../db/user.js";
import { requireSession } from "./session.js";

export async function registerIngestCredentialRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.post(
    "/ingest-credential",
    { preHandler: requireSession },
    async (_request, reply) => {
      const token = generateIngestToken();
      return reply.code(201).send({ token });
    },
  );

  // Status only - the token is never handed out on this idempotent read, so it
  // stays out of routine page-load traffic, logs, and query caches.
  fastify.get(
    "/ingest-credential",
    { preHandler: requireSession },
    async () => {
      return { configured: getIngestTokenHash() !== null };
    },
  );

  // Get-or-create for the add-server wizard: the BYO setup needs the credential the
  // moment the operator reaches it, without depending on an install-script fetch
  // having minted it first. Idempotent, so it never rotates an existing credential.
  fastify.post(
    "/ingest-credential/ensure",
    { preHandler: requireSession },
    async (request, reply) => {
      // The webhook URL is authoritative from the server's own origin (trustProxy
      // honours the public host), not window.location - the console may be served
      // from a different origin than the API in dev and split deployments.
      const origin = `${request.protocol}://${request.headers.host ?? "localhost"}`;
      return reply.code(200).send({
        token: ensureIngestToken(),
        ingestUrl: `${origin}/alerts/ingest`,
      });
    },
  );

  // Reveal is a deliberate, non-idempotent action: the plaintext only crosses the
  // wire when the operator explicitly asks for it.
  fastify.post(
    "/ingest-credential/reveal",
    { preHandler: requireSession },
    async (_request, reply) => {
      const token = getIngestTokenPlaintext();
      if (token === null) {
        return reply
          .code(404)
          .send({ error: "No ingest credential configured" });
      }
      return { token };
    },
  );
}
