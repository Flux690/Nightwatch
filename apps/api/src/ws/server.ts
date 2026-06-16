import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { findTokenByValue, touchLastUsed } from "../db/tokens.js";
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
      const plaintext = authHeader.replace(/^Bearer\s+/i, "").trim();

      if (!plaintext) {
        socket.close(4001, "Authorization header required");
        return;
      }

      const tokenRecord = findTokenByValue(plaintext);
      if (!tokenRecord) {
        socket.close(4003, "Invalid or revoked token");
        return;
      }

      const { id: tokenId } = tokenRecord;
      touchLastUsed(tokenId);

      registerRunner(
        tokenId,
        (msg) => {
          if (socket.readyState === socket.OPEN) socket.send(msg);
        },
        () => socket.close(4003, "Token revoked"),
      );

      fastify.log.info({ tokenId: tokenId.slice(0, 8) }, "runner connected");

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
          setRunnerManifest(tokenId, msg.payload);
          fastify.log.info({ tokenId: tokenId.slice(0, 8) }, "manifest stored");
        } else if (type === "result") {
          const msg = parsed as unknown as RunnerResultMessage;
          resolveCommand(msg.payload);
        } else if (type === "heartbeat") {
          recordHeartbeat(tokenId);
        }
      });

      socket.on("close", () => {
        unregisterRunner(tokenId);
        fastify.log.warn(
          { tokenId: tokenId.slice(0, 8) },
          "runner disconnected",
        );
      });

      socket.on("error", (err: Error) => {
        fastify.log.error(
          { tokenId: tokenId.slice(0, 8), err },
          "runner ws error",
        );
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
