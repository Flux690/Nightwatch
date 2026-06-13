import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { findTokenByValue, setTokenHostname } from "../db/tokens.js";
import {
  registerRunner,
  resolveCommand,
  unregisterRunner,
  setRunnerManifest,
  recordHeartbeat,
} from "./router.js";
import type {
  RunnerManifestMessage,
  RunnerResultMessage,
} from "@nightwatch/shared";

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

      const runnerIdHeader = request.headers["x-nightwatch-runner-id"];
      const runnerId =
        typeof runnerIdHeader === "string" ? runnerIdHeader.trim() : "";
      if (!runnerId) {
        socket.close(4002, "X-Nightwatch-Runner-Id header required");
        return;
      }

      const tokenRecord = findTokenByValue(token);
      if (!tokenRecord) {
        socket.close(4003, "Invalid token");
        return;
      }

      registerRunner(token, runnerId, (msg) => {
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
          setRunnerManifest(token, runnerId, msg.payload);
          setTokenHostname(token, msg.payload.hostname);
          fastify.log.info({ token: token.slice(0, 8) }, "manifest stored");
        } else if (type === "result") {
          const msg = parsed as unknown as RunnerResultMessage;
          resolveCommand(msg.payload);
        } else if (type === "heartbeat") {
          recordHeartbeat(token, runnerId);
        }
      });

      socket.on("close", () => {
        unregisterRunner(token, runnerId);
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
