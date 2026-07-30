import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { findRunnerByToken, touchLastUsed } from "../db/runner.js";
import { extractBearerToken } from "../auth/bearer.js";
import {
  registerRunner,
  unregisterRunner,
  setRunnerManifest,
  markRunnerAlive,
} from "./fleet.js";
import {
  rejectPendingForConnection,
  resolveCommand,
} from "./command-transport.js";
import type {
  RunnerManifestMessage,
  RunnerResultMessage,
} from "@nightwarden/shared";

const PING_INTERVAL_MS = 30_000;

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

      const conn = registerRunner({
        runnerId,
        platform: tokenRecord.platform,
        serverName: tokenRecord.serverName,
        send: (msg) => {
          if (socket.readyState === socket.OPEN) socket.send(msg);
        },
        close: () => socket.close(4003, "Token revoked"),
      });

      fastify.log.info({ runnerId: runnerId.slice(0, 8) }, "runner connected");

      // A peer that misses a whole ping interval is dead (half-open TCP path),
      // so terminate and let close-side cleanup settle its commands.
      let isAlive = true;
      socket.on("pong", () => {
        isAlive = true;
        markRunnerAlive(conn);
      });
      const pingTimer = setInterval(() => {
        if (!isAlive) {
          fastify.log.warn(
            { runnerId: runnerId.slice(0, 8) },
            "runner missed ping; terminating socket",
          );
          socket.terminate();
          return;
        }
        isAlive = false;
        socket.ping();
      }, PING_INTERVAL_MS);

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
        } else if (type === "result") {
          const msg = parsed as unknown as RunnerResultMessage;
          resolveCommand(msg.payload);
        }
      });

      socket.on("close", () => {
        clearInterval(pingTimer);
        // Per-socket, regardless of the registry identity check below: pending
        // commands belong to this socket even after a replacement registered.
        rejectPendingForConnection(conn);
        if (unregisterRunner(conn)) {
          fastify.log.warn(
            { runnerId: runnerId.slice(0, 8) },
            "runner disconnected",
          );
        } else {
          fastify.log.info(
            { runnerId: runnerId.slice(0, 8) },
            "stale runner socket closed after replacement",
          );
        }
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
