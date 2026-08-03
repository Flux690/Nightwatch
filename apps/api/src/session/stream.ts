import { randomUUID } from "node:crypto";
import { publishConsoleEvent } from "./bus.js";
import type { StreamDelta } from "../llm/types.js";
import type {
  ConsoleInterrupt,
  ConsoleInterruptResolved,
  ConsoleMessage,
  ConsoleReportUpdated,
  ConsoleRunFinished,
  ConsoleRunStopped,
  ConsoleSandboxStatus,
  ConsoleRunRetrying,
  ConsoleRunFailed,
  ConsoleSessionTitleUpdated,
  ConsoleTextMessageContent,
  ConsoleTranscriptItem,
  TranscriptRow,
} from "@nightwarden/shared";

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

// A persisted transcript row; the console appends it. Fires per message, many
// times per run - a content event, orthogonal to run lifecycle.
export function publishMessage(
  sessionId: string,
  message: TranscriptRow,
): void {
  const env: ConsoleMessage = {
    messageId: randomUUID(),
    type: "MESSAGE",
    payload: { sessionId, message },
  };
  publishConsoleEvent(env);
}

// The single terminal event for a run that finished on its own. The dispatcher
// is its sole caller; stopped/failed/suspended runs end via their own events.
export function publishRunFinished(sessionId: string): void {
  const env: ConsoleRunFinished = {
    messageId: randomUUID(),
    type: "RUN_FINISHED",
    payload: { sessionId, reason: "completed" },
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

// One card, built by the projection, inserted or replaced by its key.
export function publishTranscriptItem(
  payload: ConsoleTranscriptItem["payload"],
): void {
  const env: ConsoleTranscriptItem = {
    messageId: randomUUID(),
    type: "TRANSCRIPT_ITEM",
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

export function publishSandboxStatus(
  payload: ConsoleSandboxStatus["payload"],
): void {
  const env: ConsoleSandboxStatus = {
    messageId: randomUUID(),
    type: "SANDBOX_STATUS",
    payload,
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
  message: TranscriptRow,
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

export function publishSessionTitleUpdated(
  sessionId: string,
  title: string,
): void {
  const env: ConsoleSessionTitleUpdated = {
    messageId: randomUUID(),
    type: "SESSION_TITLE_UPDATED",
    payload: { sessionId, title },
  };
  publishConsoleEvent(env);
}

// The session's stored report changed; the console refetches it. Fires many
// times per run - a content event like MESSAGE, orthogonal to run lifecycle.
export function publishReportUpdated(sessionId: string): void {
  const env: ConsoleReportUpdated = {
    messageId: randomUUID(),
    type: "REPORT_UPDATED",
    payload: { sessionId },
  };
  publishConsoleEvent(env);
}
