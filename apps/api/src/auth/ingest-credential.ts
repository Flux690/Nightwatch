import type { FastifyInstance } from "fastify";
import {
  generateIngestToken,
  getIngestTokenHash,
  getIngestTokenPlaintext,
  getLastAlertReceivedAt,
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

  // Status and destination only - the token never rides this idempotent read, so it
  // stays out of page-load traffic, logs, and caches. The URL is the server's own
  // origin, never window.location: console and API can be served from different hosts.
  fastify.get(
    "/ingest-credential",
    { preHandler: requireSession },
    async (request) => {
      const origin = `${request.protocol}://${request.headers.host ?? "localhost"}`;
      return {
        configured: getIngestTokenHash() !== null,
        ingestUrl: `${origin}/alerts/ingest`,
        // Delivery proof, not configuration state: null until the user's
        // Alertmanager actually posts, and again after a rotation.
        lastReceivedAt: getLastAlertReceivedAt(),
      };
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
