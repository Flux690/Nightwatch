import type { QueueState, TranscriptRow } from "./sessions.js";
import type { TranscriptItem } from "./transcript.js";

// Common envelope for the API→frontend event stream (SSE). messageId is a per-event UUID
// inside the payload JSON, not an SSE `id:` field - the feed is drop-tolerant with no Last-Event-ID replay.
interface FrontendEnvelope {
  messageId: string;
  type: string;
  payload: unknown;
}

export interface FrontendHumanInputResolved extends FrontendEnvelope {
  type: "HUMAN_INPUT_RESOLVED";
  payload: {
    sessionId: string;
    toolUseId: string;
    status: "approved" | "rejected" | "answered" | "continued";
    resolvedAt?: string;
  };
}

export type FrontendInterruptResolved = FrontendHumanInputResolved;

// Ephemeral token delta — never persisted, only rides the in-process event bus.
export interface FrontendTextMessageContent extends FrontendEnvelope {
  type: "TEXT_MESSAGE_CONTENT";
  payload: {
    sessionId: string;
    kind: "text" | "thinking";
    delta: string;
    // The seq this turn will be saved under, sent before it is.
    turn: number;
  };
}

// A single persisted transcript row landed; the frontend appends it. Fires once
// per message, many times per run - purely a content event, never a lifecycle one.
export interface FrontendMessage extends FrontendEnvelope {
  type: "MESSAGE";
  payload: {
    sessionId: string;
    message: TranscriptRow;
  };
}

// Exactly one per run that finished on its own. Stopped, failed and suspended
// runs end on their own terminal events instead.
export interface FrontendRunFinished extends FrontendEnvelope {
  type: "RUN_FINISHED";
  payload: {
    sessionId: string;
    reason: "completed";
  };
}

// A card the API has built, to insert or replace by its key. The same projection
// serves the transcript fetch, so a live card and a reloaded one cannot differ.
export interface FrontendTranscriptItem extends FrontendEnvelope {
  type: "TRANSCRIPT_ITEM";
  payload: {
    sessionId: string;
    item: TranscriptItem;
  };
}

// Gated tool paused for approval or clarification. Resolved via POST /sessions/:id/respond.
export interface FrontendHumanInputRequired extends FrontendEnvelope {
  type: "HUMAN_INPUT_REQUIRED";
  payload: {
    sessionId: string;
    toolUseId: string;
    toolName: string;
    input: Record<string, unknown>;
    kind: "approval" | "clarification" | "continue";
    question?: string;
    options?: Array<{ label: string; description: string }>;
    multiSelect?: boolean;
  };
}

export type FrontendInterrupt = FrontendHumanInputRequired;

export interface FrontendRunStopped extends FrontendEnvelope {
  type: "RUN_STOPPED";
  payload: {
    sessionId: string;
  };
}

// Sandbox provisioning progress, so the first repo tool call never looks hung.
// Ephemeral: nothing here is persisted.
export interface FrontendSandboxStatus extends FrontendEnvelope {
  type: "SANDBOX_STATUS";
  payload: {
    sessionId: string;
    stage: "cloning" | "starting" | "installing" | "ready" | "failed";
  };
}

// A transient provider error mid-run: the run is waiting out a backoff delay,
// not dead. Ephemeral status only - nothing is persisted.
export interface FrontendRunRetrying extends FrontendEnvelope {
  type: "RUN_RETRYING";
  payload: {
    sessionId: string;
    attempt: number;
    maxAttempts: number;
    delaySeconds: number;
    summary: string;
  };
}

// An investigation died unexpectedly. Carries the persisted error row so the
// frontend appends it to the transcript exactly like a MESSAGE event.
export interface FrontendRunFailed extends FrontendEnvelope {
  type: "RUN_FAILED";
  payload: {
    sessionId: string;
    message: TranscriptRow;
  };
}

// A concise title generated asynchronously once the run starts; patches the
// sidebar list in place (the durable title is written to the sessions row).
export interface FrontendSessionTitleUpdated extends FrontendEnvelope {
  type: "SESSION_TITLE_UPDATED";
  payload: {
    sessionId: string;
    title: string;
  };
}

// The stored report changed. Fires many times per run and carries only the id,
// so the frontend refetches.
export interface FrontendReportUpdated extends FrontendEnvelope {
  type: "REPORT_UPDATED";
  payload: {
    sessionId: string;
  };
}

// Not a session event: a queued alert has no session id to name. The limit
// rides along because raising it is what the reader can act on.
export interface FrontendQueueChanged extends FrontendEnvelope {
  type: "QUEUE_CHANGED";
  payload: QueueState;
}

// Discriminated union of all events on the API→frontend SSE stream.
// Narrowing on `type` gives callers a typed `payload` for free.
export type FrontendEvent =
  | FrontendTranscriptItem
  | FrontendTextMessageContent
  | FrontendMessage
  | FrontendRunFinished
  | FrontendHumanInputRequired
  | FrontendHumanInputResolved
  | FrontendRunStopped
  | FrontendSandboxStatus
  | FrontendRunRetrying
  | FrontendRunFailed
  | FrontendSessionTitleUpdated
  | FrontendReportUpdated
  | FrontendQueueChanged;
