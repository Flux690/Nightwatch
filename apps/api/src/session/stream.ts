import { randomUUID } from "node:crypto";
import { redis } from "../redis/client.js";
import type { StreamDelta } from "../llm/types.js";
import type {
  ConsoleEscalated,
  ConsoleInterrupt,
  ConsoleInterruptResolved,
  ConsoleRunFinished,
  ConsoleTextMessageContent,
  ConsoleToolCallEnd,
  ConsoleToolCallStart,
  SessionMessage,
} from "@nightwatch/shared";

// One channel per session; the console WS pattern-subscribes to all of them.
export function sessionChannel(sessionId: string): string {
  return `session:${sessionId}`;
}

// Events not scoped to a single session (e.g. approval resolutions, which the
// console correlates by toolUseId) ride this fixed channel.
export const CONSOLE_EVENTS_CHANNEL = "console:events";

// Live events are best-effort and ephemeral - a failed publish must never break
// the investigation, so every publish swallows its error. The durable record is
// the SessionMessage persisted to the runner when the turn completes.
async function publishRaw(channel: string, env: unknown): Promise<void> {
  try {
    await redis.publish(channel, JSON.stringify(env));
  } catch {
    // streaming is best-effort
  }
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
  void publishRaw(sessionChannel(sessionId), env);
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
  void publishRaw(sessionChannel(sessionId), env);
}

export function publishToolCallStart(
  payload: ConsoleToolCallStart["payload"],
): void {
  const env: ConsoleToolCallStart = {
    messageId: randomUUID(),
    type: "TOOL_CALL_START",
    payload,
  };
  void publishRaw(sessionChannel(payload.sessionId), env);
}

export function publishInterrupt(payload: ConsoleInterrupt["payload"]): void {
  const env: ConsoleInterrupt = {
    messageId: randomUUID(),
    type: "INTERRUPT",
    payload,
  };
  void publishRaw(sessionChannel(payload.sessionId), env);
}

export function publishToolCallEnd(
  payload: ConsoleToolCallEnd["payload"],
): void {
  const env: ConsoleToolCallEnd = {
    messageId: randomUUID(),
    type: "TOOL_CALL_END",
    payload,
  };
  void publishRaw(sessionChannel(payload.sessionId), env);
}

export function publishInterruptResolved(
  payload: ConsoleInterruptResolved["payload"],
): void {
  const env: ConsoleInterruptResolved = {
    messageId: randomUUID(),
    type: "INTERRUPT_RESOLVED",
    payload,
  };
  void publishRaw(CONSOLE_EVENTS_CHANNEL, env);
}

export function publishEscalated(payload: ConsoleEscalated["payload"]): void {
  const env: ConsoleEscalated = {
    messageId: randomUUID(),
    type: "ESCALATED",
    payload,
  };
  void publishRaw(CONSOLE_EVENTS_CHANNEL, env);
}
