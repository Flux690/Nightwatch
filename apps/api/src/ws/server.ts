import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { redis } from "../redis/client.js";
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
    (socket: WebSocket, request) => {
      const authHeader = request.headers["authorization"] ?? "";
      const token = authHeader.replace(/^Bearer\s+/i, "").trim();

      if (!token) {
        socket.close(4001, "Authorization header required");
        return;
      }

      // Token becomes installationId until Prisma Installation lookup is wired (Phase 5)
      const installationId = token;

      registerRunner(installationId, (msg) => {
        if (socket.readyState === socket.OPEN) socket.send(msg);
      });

      fastify.log.info(
        { installationId: installationId.slice(0, 8) },
        "runner connected",
      );

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
          void redis.set(
            `manifest:${installationId}`,
            JSON.stringify(msg.payload),
          );
          fastify.log.info(
            { installationId: installationId.slice(0, 8) },
            "manifest stored",
          );
        } else if (type === "result") {
          const msg = parsed as unknown as RunnerResultMessage;
          resolveCommand(msg.payload);
        } else if (type === "heartbeat") {
          const _msg = parsed as unknown as RunnerHeartbeatMessage;
          const now = Date.now();
          const last = lastSeenWrites.get(installationId) ?? 0;
          if (now - last >= DEBOUNCE_MS) {
            lastSeenWrites.set(installationId, now);
            void redis.set(
              `heartbeat:${installationId}`,
              new Date().toISOString(),
              "EX",
              120,
            );
          }
        }
      });

      socket.on("close", () => {
        unregisterRunner(installationId);
        fastify.log.warn(
          { installationId: installationId.slice(0, 8) },
          "runner disconnected",
        );
      });

      socket.on("error", (err: Error) => {
        fastify.log.error(
          { installationId: installationId.slice(0, 8), err },
          "runner ws error",
        );
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
