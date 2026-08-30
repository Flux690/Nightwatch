import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import * as fastifySSEModule from "@fastify/sse";
import { requireSession } from "../auth/session.js";
import { subscribeFrontend } from "./bus.js";

// @fastify/sse's types declare ESM exports, but CJS interop puts the runtime
// fp-wrapped plugin on `default` - only the type is wrong.
const fastifySSE = fastifySSEModule.default as unknown as FastifyPluginAsync<{
  heartbeatInterval?: number;
}>;

// Relays every bus event as an SSE frame; the client routes by type/sessionId. The bus
// subscription happens before headers flush, so a client that has received headers misses no event.
export async function registerFrontendEventRoutes(
  fastify: FastifyInstance,
  opts: { heartbeatInterval?: number } = {},
): Promise<void> {
  await fastify.register(fastifySSE, opts);

  fastify.get(
    "/frontend/events",
    { sse: "only", preHandler: requireSession },
    async (_request, reply) => {
      reply.sse.keepAlive();

      const unsubscribe = subscribeFrontend((event) => {
        if (!reply.sse.isConnected) return;
        // Best-effort delivery: a send losing the race with a disconnect must
        // not throw into the investigation loop that published the event.
        reply.sse.send({ data: event }).catch(() => undefined);
      });
      reply.sse.onClose(unsubscribe);

      reply.sse.sendHeaders();
      // Flush explicitly so the client's open event isn't buffered until the
      // first published event or heartbeat.
      reply.raw.flushHeaders();
    },
  );
}
