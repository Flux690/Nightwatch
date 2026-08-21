import { randomUUID } from "node:crypto";
import type {
  FleetResult,
  Platform,
  RunnerCommandMessage,
  RunnerResultMessage,
} from "@nightwarden/shared";
import { logger } from "../logger.js";
import { resolveByRunner, resolveByService } from "./router.js";
import { addressName } from "./fleet.js";
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

// The runner never answered - its socket closed or the command ran out of time.
// Worth retrying, which is not true of a failure the runner reported back.
export class RunnerUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerUnreachableError";
  }
}

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
      new RunnerUnreachableError(
        `Command ${entry.commandName} failed: runner disconnected before responding`,
      ),
    );
  }
}

// One runner, one command, one reply.
function dispatch(
  conn: RunnerConnection,
  commandName: string,
  commandInput: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
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
        new RunnerUnreachableError(
          `Command ${commandName} timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);

    pending.set(correlationId, { resolve, reject, timer, conn, commandName });
    conn.send(JSON.stringify(msg));
  });
}

// A service-routed command finds its one owner and returns that runner's result
// unwrapped: the model asked about one service and gets one answer.
export function sendCommand(
  commandName: string,
  commandInput: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<unknown> {
  // Resolved synchronously, before the Promise: a routing error is a caller mistake and
  // should throw rather than settle a pending command. The target key expands into the
  // structured `service`; both addressing parameters are stripped before dispatch.
  const { conn, identity } = resolveByService(commandInput);
  const { target: _target, runner: _runner, container, ...rest } = commandInput;
  const service =
    container !== undefined ? { ...identity, container } : identity;
  return dispatch(conn, commandName, { ...rest, service }, timeoutMs);
}

// Reaches every runner that can serve it, in parallel, so a fan-out costs one timeout
// rather than N. The result is ALWAYS enveloped, single runner included, so the model
// and the console each have one shape to read.
export async function sendFleetCommand(
  commandName: string,
  commandInput: Record<string, unknown>,
  platform: Platform,
  timeoutMs = 15_000,
): Promise<{
  envelope: FleetResult<unknown>;
  // Counted rather than flagged: the caller has to tell a partial answer from a
  // clean one and from a dead fan-out, which one boolean cannot say.
  succeeded: number;
  failed: number;
}> {
  const conns = resolveByRunner(commandInput, platform);
  const { runner: _runner, ...payloadInput } = commandInput;

  const settled = await Promise.allSettled(
    conns.map((conn) => dispatch(conn, commandName, payloadInput, timeoutMs)),
  );

  let succeeded = 0;
  const byRunner = settled.map((toolOutcome, i) => {
    const runner = addressName(conns[i]!) ?? conns[i]!.runnerId;
    if (toolOutcome.status === "fulfilled") {
      succeeded++;
      return { runner, result: toolOutcome.value };
    }
    // One runner's failure is that entry's result, not the whole call's: the
    // others still carry evidence.
    const err: unknown = toolOutcome.reason;
    const message = err instanceof Error ? err.message : String(err);
    return { runner, result: `Error: ${message}` };
  });

  return {
    envelope: { byRunner },
    succeeded,
    failed: byRunner.length - succeeded,
  };
}
