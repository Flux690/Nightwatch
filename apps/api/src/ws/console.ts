import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { requireSession } from "../auth/session.js";
import { subscribeConsole } from "../session/bus.js";

// The console's real-time feed. It subscribes to the in-process event bus and
// relays every session event and global console event straight to the socket;
// the client routes by type and sessionId. Single-admin, so forwarding every
// event is fine. The subscription is registered synchronously before the
// `connected` ack, so no event published after the ack can be missed.
export async function registerConsoleWsRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get(
    "/console/connect",
    { websocket: true, preHandler: requireSession },
    async (socket: WebSocket) => {
      const unsubscribe = subscribeConsole((envelope: string) => {
        if (socket.readyState === socket.OPEN) socket.send(envelope);
      });

      socket.on("close", unsubscribe);
      socket.on("error", (err: Error) => {
        fastify.log.error({ err }, "console ws error");
        unsubscribe();
      });

      socket.send(
        JSON.stringify({
          messageId: randomUUID(),
          type: "connected",
          payload: {},
        }),
      );
    },
  );
}
