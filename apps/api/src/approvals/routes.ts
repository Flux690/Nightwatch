import type { FastifyInstance } from "fastify";
import { listPendingApprovals } from "../investigation/approvals.js";

export async function registerApprovalRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get<{ Querystring: { token?: string } }>(
    "/approvals/pending",
    async (request, reply) => {
      const { token } = request.query;
      if (!token) {
        return reply.code(400).send({ error: "token is required" });
      }
      return listPendingApprovals().filter((a) => a.token === token);
    },
  );
}
