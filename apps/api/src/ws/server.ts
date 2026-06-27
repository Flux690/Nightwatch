import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import {
  findRunnerByToken,
  findRunnerById,
  setRunnerId,
  setRemediationMode,
  touchLastUsed,
} from "../db/runner.js";
import { extractBearerToken } from "../auth/bearer.js";
import {
  registerRunner,
  resolveCommand,
  unregisterRunner,
  setRunnerManifest,
  recordHeartbeat,
  pushRemediationMode,
  setRunnerRemediationMode,
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
      const plaintext = extractBearerToken(request.headers.authorization);

      if (!plaintext) {
        socket.close(4001, "Authorization header required");
        return;
      }

      const tokenRecord = findRunnerByToken(plaintext);
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
          setRunnerId(tokenId, msg.payload.runnerId);
          fastify.log.info({ tokenId: tokenId.slice(0, 8) }, "manifest stored");
          // Reconcile remediation mode: re-read from DB each time since the
          // operator may have toggled since connect. Bootstrap from the
          // manifest on first arrival (null DB), then keep DB authoritative.
          // Always sync the in-memory cache so currentRemediationEnabled()
          // reads fresh state without DB round-trips.
          const currentRow = findRunnerById(tokenId);
          const dbMode = currentRow?.remediationMode ?? null;
          const manifestMode = msg.payload.capabilities.remediationEnabled;
          if (dbMode === null) {
            setRemediationMode(tokenId, manifestMode);
            setRunnerRemediationMode(tokenId, manifestMode);
          } else if (dbMode !== manifestMode) {
            pushRemediationMode(tokenId, dbMode);
          } else {
            setRunnerRemediationMode(tokenId, dbMode);
          }
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
