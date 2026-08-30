import { randomUUID } from "node:crypto";
import { queueDepth } from "./alerts-store.js";
import { countSeats } from "./run-state.js";
import { seatLimit } from "../run-pool.js";
import { publishFrontendEvent } from "./bus.js";
import type { StreamDelta } from "../llm/types.js";
import type {
  FrontendInterrupt,
  FrontendInterruptResolved,
  FrontendMessage,
  FrontendQueueChanged,
  FrontendReportUpdated,
  FrontendRunFinished,
  FrontendRunStopped,
  FrontendSandboxStatus,
  FrontendRunRetrying,
  FrontendRunFailed,
  FrontendSessionTitleUpdated,
  FrontendTextMessageContent,
  FrontendTranscriptItem,
  TranscriptRow,
} from "@nightwarden/shared";

// Every envelope goes to the one frontend bus as a typed FrontendEvent; the SSE route
// serializes it on the wire and the client routes by type/sessionId.
export function publishTextMessageContent(
  sessionId: string,
  turn: number,
  delta: StreamDelta,
): void {
  const env: FrontendTextMessageContent = {
    messageId: randomUUID(),
    type: "TEXT_MESSAGE_CONTENT",
    payload: { sessionId, kind: delta.kind, delta: delta.text, turn },
  };
  publishFrontendEvent(env);
}

// A persisted transcript row; the frontend appends it. Fires per message, many
// times per run - a content event, orthogonal to run lifecycle.
export function publishMessage(
  sessionId: string,
  message: TranscriptRow,
): void {
  const env: FrontendMessage = {
    messageId: randomUUID(),
    type: "MESSAGE",
    payload: { sessionId, message },
  };
  publishFrontendEvent(env);
}

// The single terminal event for a run that finished on its own. The dispatcher
// is its sole caller; stopped/failed/suspended runs end via their own events.
export function publishRunFinished(sessionId: string): void {
  const env: FrontendRunFinished = {
    messageId: randomUUID(),
    type: "RUN_FINISHED",
    payload: { sessionId, reason: "completed" },
  };
  publishFrontendEvent(env);
}

export function publishInterrupt(payload: FrontendInterrupt["payload"]): void {
  const env: FrontendInterrupt = {
    messageId: randomUUID(),
    type: "HUMAN_INPUT_REQUIRED",
    payload,
  };
  publishFrontendEvent(env);
}

// One card, built by the projection, inserted or replaced by its key.
export function publishTranscriptItem(
  payload: FrontendTranscriptItem["payload"],
): void {
  const env: FrontendTranscriptItem = {
    messageId: randomUUID(),
    type: "TRANSCRIPT_ITEM",
    payload,
  };
  publishFrontendEvent(env);
}

export function publishRunStopped(sessionId: string): void {
  const env: FrontendRunStopped = {
    messageId: randomUUID(),
    type: "RUN_STOPPED",
    payload: { sessionId },
  };
  publishFrontendEvent(env);
}

export function publishSandboxStatus(
  payload: FrontendSandboxStatus["payload"],
): void {
  const env: FrontendSandboxStatus = {
    messageId: randomUUID(),
    type: "SANDBOX_STATUS",
    payload,
  };
  publishFrontendEvent(env);
}

export function publishRunRetrying(
  payload: FrontendRunRetrying["payload"],
): void {
  const env: FrontendRunRetrying = {
    messageId: randomUUID(),
    type: "RUN_RETRYING",
    payload,
  };
  publishFrontendEvent(env);
}

export function publishRunFailed(
  sessionId: string,
  message: TranscriptRow,
): void {
  const env: FrontendRunFailed = {
    messageId: randomUUID(),
    type: "RUN_FAILED",
    payload: { sessionId, message },
  };
  publishFrontendEvent(env);
}

export function publishInterruptResolved(
  payload: FrontendInterruptResolved["payload"],
): void {
  const env: FrontendInterruptResolved = {
    messageId: randomUUID(),
    type: "HUMAN_INPUT_RESOLVED",
    payload,
  };
  publishFrontendEvent(env);
}

export function publishSessionTitleUpdated(
  sessionId: string,
  title: string,
): void {
  const env: FrontendSessionTitleUpdated = {
    messageId: randomUUID(),
    type: "SESSION_TITLE_UPDATED",
    payload: { sessionId, title },
  };
  publishFrontendEvent(env);
}

// The session's stored report changed; the frontend refetches it. Fires many
// times per run - a content event like MESSAGE, orthogonal to run lifecycle.
export function publishReportUpdated(sessionId: string): void {
  const env: FrontendReportUpdated = {
    messageId: randomUUID(),
    type: "REPORT_UPDATED",
    payload: { sessionId },
  };
  publishFrontendEvent(env);
}

// Published from the dispatcher and the ingest path rather than computed by
// the frontend, so the numbers are the ones the pool actually used.
export function publishQueueChanged(): void {
  const { waiting, oldestArrivedAt } = queueDepth();
  const env: FrontendQueueChanged = {
    messageId: randomUUID(),
    type: "QUEUE_CHANGED",
    payload: {
      waiting,
      running: countSeats(true),
      limit: seatLimit(true),
      oldestArrivedAt,
    },
  };
  publishFrontendEvent(env);
}
