import { randomUUID } from "node:crypto";
import type {
  RunnerCommandMessage,
  RunnerResultMessage,
} from "@nightwarden/shared";
import { logger } from "../logger.js";
import { resolveByHost, resolveByService } from "./router.js";
import type { CommandRoute } from "./router.js";
import type { RunnerConnection } from "./fleet.js";

// Request/reply correlation for runner commands, owned entirely by this
// module - the registry knows nothing about pending commands.
interface PendingCommand {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  // The socket the command went out on, so its close settles the command
  // immediately instead of waiting out the full timeout.
  conn: RunnerConnection;
  commandName: string;
}

const pending = new Map<string, PendingCommand>();

export function resolveCommand(payload: RunnerResultMessage["payload"]): void {
  const entry = pending.get(payload.correlationId);
  if (!entry) {
    // Already timed out or never existed, so this late result has nowhere to
    // go; log rather than drop silently so a slow runner is diagnosable.
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

// Called from the socket's close handler: a reply can never arrive on a
// closed socket, so waiting out the timeout would only stall the investigation.
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
): Promise<unknown> {
  // Resolve synchronously, before the Promise constructor: routing errors are
  // caller mistakes and should throw, not settle a pending command. Service routes
  // expand the target key into the structured `service` the runner resolves against,
  // folding an optional container sub-selector into it.
  let conn: RunnerConnection;
  let payloadInput = commandInput;
  if (route === "service") {
    const { conn: resolved, identity } = resolveByService(commandInput);
    conn = resolved;
    const { target: _target, container, ...rest } = commandInput;
    const service =
      container !== undefined ? { ...identity, container } : identity;
    payloadInput = { ...rest, service };
  } else {
    conn = resolveByHost(commandInput);
  }

  const correlationId = randomUUID();
  const msg: RunnerCommandMessage = {
    messageId: randomUUID(),
    type: "command",
    payload: { commandName, commandInput: payloadInput, correlationId },
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
