import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { requireSession } from "../auth/session.js";
import { subscribeConsole } from "../session/bus.js";

const LOCALHOST_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

// Built once at registration time so the env var is read exactly once per server
// instance. Two modes:
//   - No CONSOLE_ORIGINS: allow any origin whose hostname is localhost/127.0.0.1
//   - CONSOLE_ORIGINS set: exact match against the comma-separated list
function buildOriginChecker(): (origin: string | undefined) => boolean {
  const raw = process.env["CONSOLE_ORIGINS"]?.trim();
  if (!raw) {
    return (origin) => {
      if (!origin) return false;
      try {
        return LOCALHOST_HOSTNAMES.has(new URL(origin).hostname);
      } catch {
        return false;
      }
    };
  }
  const allowed = new Set(
    raw
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
  );
  return (origin) => !!origin && allowed.has(origin);
}

// The console's real-time feed. It subscribes to the in-process event bus and
// relays every session event and global console event straight to the socket;
// the client routes by type and sessionId. Single-admin, so forwarding every
// event is fine. The subscription is registered synchronously before the
// `connected` ack, so no event published after the ack can be missed.
export async function registerConsoleWsRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  const isOriginAllowed = buildOriginChecker();

  fastify.get(
    "/console/connect",
    { websocket: true, preHandler: requireSession },
    async (socket: WebSocket, request) => {
      const originHeader = request.headers["origin"];
      const origin =
        typeof originHeader === "string" ? originHeader : undefined;
      if (!isOriginAllowed(origin)) {
        socket.close(4001, "Origin not allowed");
        return;
      }

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
