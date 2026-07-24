import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { detectCapabilities } from "../manifest/detect.js";
import { logger } from "../logger.js";
import { setRemediationEnabled } from "../remediation-state.js";
import type {
  RunnerCommandMessage,
  RunnerManifestMessage,
  RunnerResultMessage,
  SetRemediationModeMessage,
} from "@nightwarden/shared";

type CommandHandler = (input: unknown) => Promise<unknown>;

const BACKOFF_STEPS = [2, 4, 8, 16, 32, 60];

// Bound on the manifest refresh so a hung Docker/k8s API cannot wedge the
// refresh interval indefinitely.
const MANIFEST_REFRESH_TIMEOUT_MS = 5000;

const MANIFEST_REFRESH_INTERVAL_MS = 30_000;

// Three missed server ping intervals (30s each). A silently dead path (NAT expiry, no FIN) never
// errors the socket on its own - sends just buffer - so silence from the API is the only reliable death signal on this side.
const PING_WATCHDOG_MS = 90_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const t = setTimeout(
        () => reject(new Error(`timed out after ${ms}ms`)),
        ms,
      );
      // Don't let the timeout keep the process alive on its own.
      t.unref();
    }),
  ]);
}

export function startWebSocketClient(
  dispatch: Map<string, CommandHandler>,
): () => void {
  const wsUrl =
    process.env["WS_URL"] ||
    (() => {
      throw new Error("WS_URL environment variable is required");
    })();
  const token = process.env["NIGHTWARDEN_TOKEN"]!;

  let ws: WebSocket | null = null;
  let retryCount = 0;
  let manifestTimer: ReturnType<typeof setInterval> | null = null;
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function clearManifestRefresh(): void {
    if (manifestTimer) {
      clearInterval(manifestTimer);
      manifestTimer = null;
    }
  }

  function clearWatchdog(): void {
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  }

  function armWatchdog(socket: WebSocket): void {
    clearWatchdog();
    watchdogTimer = setTimeout(() => {
      logger.warn(
        { timeoutMs: PING_WATCHDOG_MS },
        "no ping from API; terminating socket to force reconnect",
      );
      socket.terminate();
    }, PING_WATCHDOG_MS);
  }

  function scheduleReconnect(): void {
    const delaySec =
      BACKOFF_STEPS[Math.min(retryCount, BACKOFF_STEPS.length - 1)] ?? 60;
    retryCount++;
    logger.warn({ delaySec, attempt: retryCount }, "reconnecting");
    reconnectTimer = setTimeout(connect, delaySec * 1000);
  }

  async function sendManifest(socket: WebSocket): Promise<void> {
    const manifest = await withTimeout(
      detectCapabilities(),
      MANIFEST_REFRESH_TIMEOUT_MS,
    );
    if (socket.readyState !== WebSocket.OPEN) return;
    const msg: RunnerManifestMessage = {
      messageId: randomUUID(),
      type: "manifest",
      payload: manifest,
    };
    socket.send(JSON.stringify(msg));
  }

  function startManifestRefresh(socket: WebSocket): void {
    manifestTimer = setInterval(() => {
      sendManifest(socket).catch((err: unknown) =>
        logger.warn({ err }, "manifest refresh failed or timed out"),
      );
    }, MANIFEST_REFRESH_INTERVAL_MS);
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
      startManifestRefresh(ws!);
      // Armed on open so a connection that never gets pinged is also detected.
      armWatchdog(ws!);
    });

    // ws auto-pongs at the protocol level; receiving the ping is itself the
    // proof the API can reach us, so it just re-arms the watchdog.
    ws.on("ping", () => {
      armWatchdog(ws!);
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
      } else if (parsed["type"] === "set_remediation_mode") {
        const msg = parsed as unknown as SetRemediationModeMessage;
        setRemediationEnabled(msg.payload.enabled);
        logger.info(
          { enabled: msg.payload.enabled },
          "remediation mode updated",
        );
      }
    });

    ws.on("close", (code) => {
      clearManifestRefresh();
      clearWatchdog();
      if (stopped) return;
      logger.warn({ code }, "ws closed");
      scheduleReconnect();
    });

    ws.on("error", (err) => {
      // Tearing down a connecting socket surfaces as an error event; after
      // stop() that is expected shutdown noise, not a fault.
      if (stopped) return;
      logger.error({ err }, "ws error");
      // 'close' fires after 'error', which triggers reconnect
    });
  }

  connect();

  return function stop(): void {
    stopped = true;
    clearManifestRefresh();
    clearWatchdog();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    ws?.terminate();
  };
}
