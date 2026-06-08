import type { FastifyInstance } from "fastify";
import { redis } from "../redis/client.js";
import { sendCommand } from "../ws/router.js";
import type { DashboardQuery } from "@nightwatch/shared";

const RELAY_TIMEOUT_MS = 10_000;

// History changes slowly; live state must stay fresh. TTLs match PRD 6.6 and
// stay <= what the console's React Query staleTime expects.
const HISTORY_TTL_S = 300;
const STATE_TTL_S = 30;
const HISTORY_TYPES = new Set<DashboardQuery["type"]>([
  "get_incident_history",
  "get_incident_detail",
  "get_sessions",
  "get_session_messages",
]);

// Relay a read-only dashboard query to the runner, caching the result so the
// console can poll without hammering the runner. The API never reads runner
// data independently - it always relays (PRD 6.6).
export async function registerRelayRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.post<{ Params: { token: string }; Body: DashboardQuery }>(
    "/client-query/:token",
    async (request, reply) => {
      const { token } = request.params;
      const query = request.body;
      if (!query?.type) {
        return reply.code(400).send({ error: "query type is required" });
      }

      const cacheKey = `relay:${token}:${query.type}:${JSON.stringify(
        query.params ?? {},
      )}`;
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached);

      try {
        const result = await sendCommand(
          token,
          query.type,
          query.params ?? {},
          RELAY_TIMEOUT_MS,
        );
        const ttl = HISTORY_TYPES.has(query.type) ? HISTORY_TTL_S : STATE_TTL_S;
        await redis.set(cacheKey, JSON.stringify(result), "EX", ttl);
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(502).send({ error: msg });
      }
    },
  );
}
