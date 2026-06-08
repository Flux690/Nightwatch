import { randomUUID } from "node:crypto";
import { redis } from "../redis/client.js";
import type { StreamDelta } from "../llm/types.js";
import type {
  ConsoleSessionDelta,
  ConsoleSessionMessage,
  ConsoleToolCall,
  SessionMessage,
} from "@nightwatch/shared";

// One channel per session; the console WS subscribes to the sessions it views.
export function sessionChannel(sessionId: string): string {
  return `session:${sessionId}`;
}

// Live deltas are best-effort and ephemeral - a failed publish must never break
// the investigation, so every publish swallows its error. The durable record is
// the SessionMessage persisted to the runner when the turn completes.
async function publish(sessionId: string, env: unknown): Promise<void> {
  try {
    await redis.publish(sessionChannel(sessionId), JSON.stringify(env));
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
  void publish(sessionId, env);
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
  void publish(sessionId, env);
}

export function publishToolCall(payload: ConsoleToolCall["payload"]): void {
  const env: ConsoleToolCall = {
    messageId: randomUUID(),
    type: "tool_call",
    payload,
  };
  void publish(payload.sessionId, env);
}
