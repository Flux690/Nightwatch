import { randomUUID } from "node:crypto";
import { publishConsoleEvent } from "./bus.js";
import type { StreamDelta } from "../llm/types.js";
import type {
  ConsoleInterrupt,
  ConsoleInterruptResolved,
  ConsoleRunFinished,
  ConsoleTextMessageContent,
  ConsoleToolCallEnd,
  ConsoleToolCallStart,
  SessionMessage,
} from "@nightwatch/shared";

// Every envelope goes to the one console bus; the console WS forwards all of
// them and the client routes by type and sessionId. Publishing is synchronous
// and in-process now, so there is nothing to fail - but the serialized form
// stays the wire-identical envelope the console already parses.
function publishRaw(env: unknown): void {
  publishConsoleEvent(JSON.stringify(env));
}

export function publishTextMessageContent(
  sessionId: string,
  delta: StreamDelta,
): void {
  const env: ConsoleTextMessageContent = {
    messageId: randomUUID(),
    type: "TEXT_MESSAGE_CONTENT",
    payload: { sessionId, kind: delta.kind, delta: delta.text },
  };
  publishRaw(env);
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
  publishRaw(env);
}

export function publishToolCallStart(
  payload: ConsoleToolCallStart["payload"],
): void {
  const env: ConsoleToolCallStart = {
    messageId: randomUUID(),
    type: "TOOL_CALL_START",
    payload,
  };
  publishRaw(env);
}

export function publishInterrupt(payload: ConsoleInterrupt["payload"]): void {
  const env: ConsoleInterrupt = {
    messageId: randomUUID(),
    type: "HUMAN_INPUT_REQUIRED",
    payload,
  };
  publishRaw(env);
}

export function publishToolCallEnd(
  payload: ConsoleToolCallEnd["payload"],
): void {
  const env: ConsoleToolCallEnd = {
    messageId: randomUUID(),
    type: "TOOL_CALL_END",
    payload,
  };
  publishRaw(env);
}

export function publishInterruptResolved(
  payload: ConsoleInterruptResolved["payload"],
): void {
  const env: ConsoleInterruptResolved = {
    messageId: randomUUID(),
    type: "HUMAN_INPUT_RESOLVED",
    payload,
  };
  publishRaw(env);
}
