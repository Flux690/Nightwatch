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

  fastify.get(
    "/ingest-credential",
    { preHandler: requireSession },
    async () => {
      const configured = getIngestTokenHash() !== null;
      const token = configured ? getIngestTokenPlaintext() : null;
      return { configured, token };
    },
  );
}
