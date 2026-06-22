import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { detectCapabilities } from "../manifest/detect.js";
import { logger } from "../logger.js";
import type {
  RunnerCommandMessage,
  RunnerHeartbeatMessage,
  RunnerManifestMessage,
  RunnerResultMessage,
} from "@nightwatch/shared";

type CommandHandler = (input: unknown) => Promise<unknown>;

const BACKOFF_STEPS = [2, 4, 8, 16, 32, 60];

export function startWebSocketClient(
  dispatch: Map<string, CommandHandler>,
): void {
  const wsUrl =
    process.env["WS_URL"] ||
    (() => {
      throw new Error("WS_URL environment variable is required");
    })();
  const token = process.env["NIGHTWATCH_TOKEN"]!;

  let ws: WebSocket | null = null;
  let retryCount = 0;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  function clearHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function scheduleReconnect(): void {
    const delaySec =
      BACKOFF_STEPS[Math.min(retryCount, BACKOFF_STEPS.length - 1)] ?? 60;
    retryCount++;
    logger.warn({ delaySec, attempt: retryCount }, "reconnecting");
    setTimeout(connect, delaySec * 1000);
  }

  async function sendManifest(socket: WebSocket): Promise<void> {
    const manifest = await detectCapabilities();
    const msg: RunnerManifestMessage = {
      messageId: randomUUID(),
      type: "manifest",
      payload: manifest,
    };
    socket.send(JSON.stringify(msg));
  }

  async function sendHeartbeat(socket: WebSocket): Promise<void> {
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      const manifest = await detectCapabilities();
      if (socket.readyState === WebSocket.OPEN) {
        const manifestMsg: RunnerManifestMessage = {
          messageId: randomUUID(),
          type: "manifest",
          payload: manifest,
        };
        socket.send(JSON.stringify(manifestMsg));
      }
    } catch (err: unknown) {
      // Manifest refresh failed (e.g. Docker daemon temporarily unreachable).
      // Log and continue so the heartbeat still goes out and the API does not
      // mark this runner offline.
      logger.warn({ err }, "heartbeat manifest refresh failed");
    }
    if (socket.readyState !== WebSocket.OPEN) return;
    const heartbeatMsg: RunnerHeartbeatMessage = {
      messageId: randomUUID(),
      type: "heartbeat",
      payload: { timestamp: new Date().toISOString() },
    };
    socket.send(JSON.stringify(heartbeatMsg));
  }

  function startHeartbeat(socket: WebSocket): void {
    heartbeatTimer = setInterval(() => {
      sendHeartbeat(socket).catch((err: unknown) =>
        logger.error({ err }, "heartbeat failed"),
      );
    }, 30_000);
  }

  async function handleCommand(
    socket: WebSocket,
    msg: RunnerCommandMessage,
  ): Promise<void> {
    const { commandName, commandInput, correlationId } = msg.payload;
    const handler = dispatch.get(commandName);

    let resultMsg: RunnerResultMessage;
    if (!handler) {
      resultMsg = {
        messageId: randomUUID(),
        type: "result",
        payload: {
          correlationId,
          success: false,
          result: null,
          error: `Unknown command: ${commandName}`,
        },
      };
    } else {
      try {
        const result = await handler(commandInput);
        resultMsg = {
          messageId: randomUUID(),
          type: "result",
          payload: { correlationId, success: true, result },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        resultMsg = {
          messageId: randomUUID(),
          type: "result",
          payload: {
            correlationId,
            success: false,
            result: null,
            error: message,
          },
        };
      }
    }

    socket.send(JSON.stringify(resultMsg));
  }

  function connect(): void {
    ws = new WebSocket(wsUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    ws.on("open", () => {
      retryCount = 0;
      logger.info("ws connected");
      sendManifest(ws!).catch((err: unknown) =>
        logger.error({ err }, "manifest send failed"),
      );
      startHeartbeat(ws!);
    });

    ws.on("message", (data) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        return;
      }

      if (parsed["type"] === "command") {
        handleCommand(ws!, parsed as unknown as RunnerCommandMessage).catch(
          (err: unknown) => logger.error({ err }, "command handler error"),
        );
      }
    });

    ws.on("close", (code) => {
      clearHeartbeat();
      logger.warn({ code }, "ws closed");
      scheduleReconnect();
    });

    ws.on("error", (err) => {
      logger.error({ err }, "ws error");
      // 'close' fires after 'error', which triggers reconnect
    });
  }

  connect();
}
