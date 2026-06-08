import { randomUUID } from "node:crypto";
import { redis } from "../redis/client.js";
import type { StreamDelta } from "../llm/types.js";
import type {
  ConsoleApprovalUpdate,
  ConsoleSessionDelta,
  ConsoleSessionMessage,
  ConsoleToolCall,
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

export function publishSessionDelta(
  sessionId: string,
  delta: StreamDelta,
): void {
  const env: ConsoleSessionDelta = {
    messageId: randomUUID(),
    type: "session_delta",
    payload: { sessionId, kind: delta.kind, delta: delta.text },
  };
  void publishRaw(sessionChannel(sessionId), env);
}

export function publishSessionMessage(
  sessionId: string,
  message: SessionMessage,
): void {
  const env: ConsoleSessionMessage = {
    messageId: randomUUID(),
    type: "session_message",
    payload: { sessionId, message },
  };
  void publishRaw(sessionChannel(sessionId), env);
}

export function publishToolCall(payload: ConsoleToolCall["payload"]): void {
  const env: ConsoleToolCall = {
    messageId: randomUUID(),
    type: "tool_call",
    payload,
  };
  void publishRaw(sessionChannel(payload.sessionId), env);
}

export function publishApprovalUpdate(
  payload: ConsoleApprovalUpdate["payload"],
): void {
  const env: ConsoleApprovalUpdate = {
    messageId: randomUUID(),
    type: "approval_update",
    payload,
  };
  void publishRaw(CONSOLE_EVENTS_CHANNEL, env);
}
