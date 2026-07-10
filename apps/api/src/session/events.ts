import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import * as fastifySSEModule from "@fastify/sse";
import { requireSession } from "../auth/session.js";
import { subscribeConsole } from "./bus.js";

// Interop assertion: @fastify/sse is CJS whose module.exports is the fp-wrapped
// plugin, but its d.ts declares only ESM-style exports, which at runtime are the
// raw, unwrapped plugin - registering those would encapsulate reply.sse away
// from every route. Per Node's CJS interop the namespace's `default` IS the
// wrapped module.exports; only its declared type is wrong, hence the cast.
const fastifySSE = fastifySSEModule.default as unknown as FastifyPluginAsync<{
  heartbeatInterval?: number;
}>;

// The console's real-time feed: relays every bus event as an SSE frame; the client
// routes by type/sessionId. The bus subscription happens before headers are flushed,
// so a client that has received headers misses no later event.
export async function registerConsoleEventRoutes(
  fastify: FastifyInstance,
  opts: { heartbeatInterval?: number } = {},
): Promise<void> {
  await fastify.register(fastifySSE, opts);

  fastify.get(
    "/console/events",
    { sse: "only", preHandler: requireSession },
    async (_request, reply) => {
      reply.sse.keepAlive();

      const unsubscribe = subscribeConsole((event) => {
        if (!reply.sse.isConnected) return;
        // Best-effort delivery: a send losing the race with a disconnect must
        // not throw into the investigation loop that published the event.
        reply.sse.send({ data: event }).catch(() => undefined);
      });
      reply.sse.onClose(unsubscribe);

      reply.sse.sendHeaders();
      // sendHeaders only records status/headers on the raw response; Node
      // buffers them until the first body write. Flush explicitly so the
      // client's open event (= "subscribed, no event can be missed") does not
      // wait for the first published event or heartbeat.
      reply.raw.flushHeaders();
    },
  );
}
