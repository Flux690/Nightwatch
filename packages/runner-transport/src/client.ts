import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import type {
  RunnerManifest,
  RunnerCommandMessage,
  RunnerManifestMessage,
  RunnerResultMessage,
  HideContainerMessage,
} from "@nightwarden/shared";

export type CommandHandler = (input: unknown) => Promise<unknown>;

// Structural, so a pino logger satisfies it without this package depending on pino.
export interface TransportLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface TransportOptions {
  wsUrl: string;
  token: string;
  // What this runner can answer. Handed in rather than imported: the transport
  // never learns which platform it is carrying.
  dispatch: Map<string, CommandHandler>;
  buildManifest: () => Promise<RunnerManifest>;
  logger: TransportLogger;
  // Docker only: the API naming its own container so the runner can keep the
  // control plane out of what it enumerates.
  onHideContainer?: (containerId: string) => void;
}

const BACKOFF_STEPS = [2, 4, 8, 16, 32, 60];

// Bound on the manifest refresh so a hung platform API cannot wedge the
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

export function startWebSocketClient(options: TransportOptions): () => void {
  const { wsUrl, token, dispatch, buildManifest, logger, onHideContainer } =
    options;

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
    const manifest: RunnerManifest = await withTimeout(
      buildManifest(),
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
      logger.info({}, "ws connected");
      sendManifest(ws!).catch((err: unknown) =>
        logger.error({ err }, "manifest send failed"),
      );
      startManifestRefresh(ws!);
      // Armed on open so a connection that never gets pinged is also detected.
      armWatchdog(ws!);
    });

    // ws auto-pongs at the protocol level; receiving the ping is itself the
    // proof the API can reach us, so it re-arms the watchdog and is also what
    // clears the backoff. Opening is not enough: a runner the API accepts and
    // then rejects (revoked token, wrong platform) opens every time, so resetting
    // on open would hold it at the first rung and hammer every two seconds
    // forever. Only a connection the API is willing to keep gets pinged.
    ws.on("ping", () => {
      retryCount = 0;
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
      } else if (parsed["type"] === "hide_container" && onHideContainer) {
        const msg = parsed as unknown as HideContainerMessage;
        onHideContainer(msg.payload.containerId);
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
