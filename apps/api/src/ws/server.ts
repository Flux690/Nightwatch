import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import {
  findRunnerByToken,
  findRunnerById,
  setRemediationMode,
  touchLastUsed,
} from "../db/runner.js";
import { extractBearerToken } from "../auth/bearer.js";
import {
  registerRunner,
  unregisterRunner,
  setRunnerManifest,
  recordHeartbeat,
  pushRemediationMode,
  setRunnerRemediationMode,
} from "./router.js";
import { resolveCommand } from "./command-transport.js";
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

      const { id: runnerId } = tokenRecord;

      registerRunner(
        runnerId,
        (msg) => {
          if (socket.readyState === socket.OPEN) socket.send(msg);
        },
        () => socket.close(4003, "Token revoked"),
      );

      fastify.log.info({ runnerId: runnerId.slice(0, 8) }, "runner connected");

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
          touchLastUsed(runnerId);
          setRunnerManifest(runnerId, msg.payload);
          fastify.log.info(
            { runnerId: runnerId.slice(0, 8) },
            "manifest stored",
          );
          // Reconcile remediation mode: re-read from DB each time (the operator may have toggled),
          // bootstrap from the manifest on first arrival (null DB), then keep DB authoritative. Always
          // sync the in-memory cache so reads need no DB round-trip.
          const currentRow = findRunnerById(runnerId);
          const dbMode = currentRow?.remediationMode ?? null;
          const manifestMode = msg.payload.capabilities.remediationEnabled;
          if (dbMode === null) {
            setRemediationMode(runnerId, manifestMode);
            setRunnerRemediationMode(runnerId, manifestMode);
          } else if (dbMode !== manifestMode) {
            pushRemediationMode(runnerId, dbMode);
          } else {
            setRunnerRemediationMode(runnerId, dbMode);
          }
        } else if (type === "result") {
          const msg = parsed as unknown as RunnerResultMessage;
          resolveCommand(msg.payload);
        } else if (type === "heartbeat") {
          recordHeartbeat(runnerId);
        }
      });

      socket.on("close", () => {
        unregisterRunner(runnerId);
        fastify.log.warn(
          { runnerId: runnerId.slice(0, 8) },
          "runner disconnected",
        );
      });

      socket.on("error", (err: Error) => {
        fastify.log.error(
          { runnerId: runnerId.slice(0, 8), err },
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
