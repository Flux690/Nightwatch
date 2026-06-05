import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { redis } from "../redis/client.js";
import { db } from "../db/client.js";
import { registerRunner, resolveCommand, unregisterRunner } from "./router.js";
import type {
  RunnerHeartbeatMessage,
  RunnerManifestMessage,
  RunnerResultMessage,
} from "@nightwatch/shared";

const DEBOUNCE_MS = 30_000;
const lastSeenWrites = new Map<string, number>();

export async function registerWsRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get(
    "/clients/connect",
    { websocket: true },
    async (socket: WebSocket, request) => {
      const authHeader = request.headers["authorization"] ?? "";
      const token = authHeader.replace(/^Bearer\s+/i, "").trim();

      if (!token) {
        socket.close(4001, "Authorization header required");
        return;
      }

      const installation = await db.installation.findUnique({
        where: { token },
      });
      if (!installation) {
        socket.close(4003, "Invalid token");
        return;
      }

      registerRunner(token, (msg) => {
        if (socket.readyState === socket.OPEN) socket.send(msg);
      });

      fastify.log.info({ token: token.slice(0, 8) }, "runner connected");

      socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(String(raw)) as Record<string, unknown>;
        } catch {
          return;
        }

        const type = parsed["type"];

        if (type === "manifest") {
          const msg = parsed as unknown as RunnerManifestMessage;
          void redis.set(`manifest:${token}`, JSON.stringify(msg.payload));
          void db.installation.update({
            where: { token },
            data: { hostname: msg.payload.hostname },
          });
          fastify.log.info({ token: token.slice(0, 8) }, "manifest stored");
        } else if (type === "result") {
          const msg = parsed as unknown as RunnerResultMessage;
          resolveCommand(msg.payload);
        } else if (type === "heartbeat") {
          const _msg = parsed as unknown as RunnerHeartbeatMessage;
          const now = Date.now();
          const last = lastSeenWrites.get(token) ?? 0;
          if (now - last >= DEBOUNCE_MS) {
            lastSeenWrites.set(token, now);
            void redis.set(
              `heartbeat:${token}`,
              new Date().toISOString(),
              "EX",
              120,
            );
          }
        }
      });

      socket.on("close", () => {
        unregisterRunner(token);
        fastify.log.warn({ token: token.slice(0, 8) }, "runner disconnected");
      });

      socket.on("error", (err: Error) => {
        fastify.log.error({ token: token.slice(0, 8), err }, "runner ws error");
      });

      // Identify this socket
      const welcomeId = randomUUID();
      socket.send(
        JSON.stringify({
          messageId: welcomeId,
          type: "connected",
          payload: {},
        }),
      );
    },
  );
}
