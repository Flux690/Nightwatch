import type { FastifyInstance } from "fastify";
import { generateIngestToken, getIngestTokenHash } from "../db/user.js";
import { requireSession } from "./session.js";

export async function registerIngestCredentialRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // Generate (or rotate) the fleet-wide nwi_ credential. The plaintext is
  // returned exactly once here and never stored - the DB holds only the
  // SHA-256 hash. Calling this again replaces the hash, so the previous
  // credential stops working immediately.
  fastify.post(
    "/ingest-credential",
    { preHandler: requireSession },
    async (_request, reply) => {
      const token = generateIngestToken();
      return reply.code(201).send({ token });
    },
  );

  // No plaintext is ever returned - just whether a credential exists.
  fastify.get(
    "/ingest-credential",
    { preHandler: requireSession },
    async () => ({ configured: getIngestTokenHash() !== null }),
  );
}
