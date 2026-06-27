import type { FastifyInstance } from "fastify";
import {
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
