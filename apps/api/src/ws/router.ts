import { randomUUID } from "node:crypto";
import type {
  RunnerCommandMessage,
  RunnerResultMessage,
} from "@nightwatch/shared";

interface PendingCommand {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingCommand>();

// token -> runnerId -> send. Keying by runnerId (not token alone) stops a second
// runner sharing the same token from overwriting the first runner's socket.
// sendCommand routes by token and picks any live runner; targeting a specific
// runner is future work.
const registry = new Map<string, Map<string, (msg: string) => void>>();

export class RunnerOfflineError extends Error {
  constructor(token: string) {
    super(`Runner for token ${token} is offline`);
    this.name = "RunnerOfflineError";
  }
}

export function registerRunner(
  token: string,
  runnerId: string,
  send: (msg: string) => void,
): void {
  let runners = registry.get(token);
  if (!runners) {
    runners = new Map();
    registry.set(token, runners);
  }
  runners.set(runnerId, send);
}

export function unregisterRunner(token: string, runnerId: string): void {
  const runners = registry.get(token);
  if (!runners) return;
  runners.delete(runnerId);
  if (runners.size === 0) registry.delete(token);
}

export function resolveCommand(payload: RunnerResultMessage["payload"]): void {
  const entry = pending.get(payload.correlationId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(payload.correlationId);
  if (payload.success) {
    entry.resolve(payload.result);
  } else {
    entry.reject(new Error(payload.error ?? "Runner command failed"));
  }
}

export function sendCommand(
  token: string,
  commandName: string,
  commandInput: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<unknown> {
  const runners = registry.get(token);
  const send = runners?.values().next().value;
  if (!send) throw new RunnerOfflineError(token);

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

    pending.set(correlationId, { resolve, reject, timer });
    send(JSON.stringify(msg));
  });
}
