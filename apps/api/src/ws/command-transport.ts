import { randomUUID } from "node:crypto";
import type {
  RunnerCommandMessage,
  RunnerResultMessage,
} from "@nightwatch/shared";
import { logger } from "../logger.js";
import { resolveByHost, resolveByService } from "./router.js";
import type { CommandRoute, RunnerConnection } from "./router.js";

// In-flight request/reply correlation for runner commands. A command is sent with
// a correlationId; the runner's result is matched back here. This map is owned
// entirely by this module - the registry knows nothing about pending commands.
interface PendingCommand {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  // The exact socket the command went out on; a reply can only ever arrive on
  // it, so its close settles the command immediately instead of waiting out
  // the full timeout.
  conn: RunnerConnection;
  commandName: string;
}

const pending = new Map<string, PendingCommand>();

export function resolveCommand(payload: RunnerResultMessage["payload"]): void {
  const entry = pending.get(payload.correlationId);
  if (!entry) {
    // The command already timed out (and rejected its caller) or never existed,
    // so a late result has nowhere to go. Log it instead of dropping silently,
    // so a consistently-slow runner is diagnosable.
    logger.warn(
      { correlationId: payload.correlationId },
      "late or unknown runner result discarded",
    );
    return;
  }
  clearTimeout(entry.timer);
  pending.delete(payload.correlationId);
  if (payload.success) {
    entry.resolve(payload.result);
  } else {
    entry.reject(new Error(payload.error ?? "Runner command failed"));
  }
}

// Settle every command still in flight on this exact socket. Called from the
// socket's close handler: a reply can never arrive on a closed socket, so
// waiting out the timeout would only stall the investigation.
export function rejectPendingForConnection(conn: RunnerConnection): void {
  for (const [correlationId, entry] of pending) {
    if (entry.conn !== conn) continue;
    clearTimeout(entry.timer);
    pending.delete(correlationId);
    entry.reject(
      new Error(
        `Command ${entry.commandName} failed: runner disconnected before responding`,
      ),
    );
  }
}

export function sendCommand(
  commandName: string,
  commandInput: Record<string, unknown>,
  route: CommandRoute,
  timeoutMs = 15_000,
  runnerIdHint?: string,
): Promise<unknown> {
  // Resolve synchronously, before the Promise constructor: routing errors are
  // caller mistakes and should throw, not settle a pending command.
  const conn =
    route === "service"
      ? resolveByService(commandInput)
      : resolveByHost(commandInput, runnerIdHint);

  const correlationId = randomUUID();
  const msg: RunnerCommandMessage = {
    messageId: randomUUID(),
    type: "command",
    payload: { commandName, commandInput, correlationId },
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(correlationId);
      reject(
        new Error(`Command ${commandName} timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);

    pending.set(correlationId, { resolve, reject, timer, conn, commandName });
    conn.send(JSON.stringify(msg));
  });
}
