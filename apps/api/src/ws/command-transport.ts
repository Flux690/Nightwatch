import { randomUUID } from "node:crypto";
import type {
  RunnerCommandMessage,
  RunnerResultMessage,
} from "@nightwatch/shared";
import { logger } from "../logger.js";
import { resolveRunner } from "./router.js";

// In-flight request/reply correlation for runner commands. A command is sent with
// a correlationId; the runner's result is matched back here. This map is owned
// entirely by this module - the registry knows nothing about pending commands.
interface PendingCommand {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
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

export function sendCommand(
  commandName: string,
  commandInput: Record<string, unknown>,
  timeoutMs = 15_000,
  runnerIdHint?: string,
): Promise<unknown> {
  const { send } = resolveRunner(commandInput, runnerIdHint);

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
