import { randomUUID } from "node:crypto";
import { publishConsoleEvent } from "./bus.js";
import type { StreamDelta } from "../llm/types.js";
import type {
  ConsoleInterrupt,
  ConsoleInterruptResolved,
  ConsoleRunFinished,
  ConsoleRunStopped,
  ConsoleRunRetrying,
  ConsoleRunFailed,
  ConsoleTextMessageContent,
  ConsoleToolCallEnd,
  ConsoleToolCallStart,
  SessionMessage,
} from "@nightwatch/shared";

// Every envelope goes to the one console bus as a typed ConsoleEvent; the SSE route
// serializes it on the wire and the client routes by type/sessionId.
export function publishTextMessageContent(
  sessionId: string,
  delta: StreamDelta,
): void {
  const env: ConsoleTextMessageContent = {
    messageId: randomUUID(),
    type: "TEXT_MESSAGE_CONTENT",
    payload: { sessionId, kind: delta.kind, delta: delta.text },
  };
  publishConsoleEvent(env);
}

export function publishRunFinished(
  sessionId: string,
  message: SessionMessage,
): void {
  const env: ConsoleRunFinished = {
    messageId: randomUUID(),
    type: "RUN_FINISHED",
    payload: { sessionId, message },
  };
  publishConsoleEvent(env);
}

export function publishToolCallStart(
  payload: ConsoleToolCallStart["payload"],
): void {
  const env: ConsoleToolCallStart = {
    messageId: randomUUID(),
    type: "TOOL_CALL_START",
    payload,
  };
  publishConsoleEvent(env);
}

export function publishInterrupt(payload: ConsoleInterrupt["payload"]): void {
  const env: ConsoleInterrupt = {
    messageId: randomUUID(),
    type: "HUMAN_INPUT_REQUIRED",
    payload,
  };
  publishConsoleEvent(env);
}

export function publishToolCallEnd(
  payload: ConsoleToolCallEnd["payload"],
): void {
  const env: ConsoleToolCallEnd = {
    messageId: randomUUID(),
    type: "TOOL_CALL_END",
    payload,
  };
  publishConsoleEvent(env);
}

export function publishRunStopped(sessionId: string): void {
  const env: ConsoleRunStopped = {
    messageId: randomUUID(),
    type: "RUN_STOPPED",
    payload: { sessionId },
  };
  publishConsoleEvent(env);
}

export function publishRunRetrying(
  payload: ConsoleRunRetrying["payload"],
): void {
  const env: ConsoleRunRetrying = {
    messageId: randomUUID(),
    type: "RUN_RETRYING",
    payload,
  };
  publishConsoleEvent(env);
}

export function publishRunFailed(
  sessionId: string,
  message: SessionMessage,
): void {
  const env: ConsoleRunFailed = {
    messageId: randomUUID(),
    type: "RUN_FAILED",
    payload: { sessionId, message },
  };
  publishConsoleEvent(env);
}

export function publishInterruptResolved(
  payload: ConsoleInterruptResolved["payload"],
): void {
  const env: ConsoleInterruptResolved = {
    messageId: randomUUID(),
    type: "HUMAN_INPUT_RESOLVED",
    payload,
  };
  publishConsoleEvent(env);
}
