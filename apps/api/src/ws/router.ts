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
const registry = new Map<string, (msg: string) => void>();

export class RunnerOfflineError extends Error {
  constructor(installationId: string) {
    super(`Runner for installation ${installationId} is offline`);
    this.name = "RunnerOfflineError";
  }
}

export function registerRunner(
  installationId: string,
  send: (msg: string) => void,
): void {
  registry.set(installationId, send);
}

export function unregisterRunner(installationId: string): void {
  registry.delete(installationId);
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
  installationId: string,
  commandName: string,
  commandInput: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<unknown> {
  const send = registry.get(installationId);
  if (!send) throw new RunnerOfflineError(installationId);

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
