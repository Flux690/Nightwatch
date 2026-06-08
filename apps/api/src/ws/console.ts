import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { redis } from "../redis/client.js";
import { CONSOLE_EVENTS_CHANNEL } from "../session/stream.js";

const SESSION_PATTERN = "session:*";

// The console's real-time feed. A dedicated subscriber connection (a connection
// in subscribe mode cannot issue normal commands) relays every session event
// and global console event straight to the socket; the client routes by type
// and sessionId. Single-admin, so pattern-subscribing to all sessions is fine.
export async function registerConsoleWsRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get(
    "/console/connect",
    { websocket: true },
    async (socket: WebSocket) => {
      const sub = redis.duplicate();

      const forward = (message: string): void => {
        if (socket.readyState === socket.OPEN) socket.send(message);
      };
      sub.on("pmessage", (_pattern, _channel, message) => forward(message));
      sub.on("message", (_channel, message) => forward(message));

      try {
        await sub.psubscribe(SESSION_PATTERN);
        await sub.subscribe(CONSOLE_EVENTS_CHANNEL);
      } catch (err) {
        fastify.log.error({ err }, "console ws subscribe failed");
        socket.close(1011, "subscribe failed");
        void sub.quit();
        return;
      }

      socket.on("close", () => {
        void sub.quit();
      });
      socket.on("error", (err: Error) => {
        fastify.log.error({ err }, "console ws error");
        void sub.quit();
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
