import type { SessionMessage } from "./sessions.js";
import type { TranscriptItem } from "./transcript.js";

// Common envelope for the API→console event stream (SSE). messageId is a per-event UUID
// inside the payload JSON, not an SSE `id:` field - the feed is drop-tolerant with no Last-Event-ID replay.
interface ConsoleEnvelope {
  messageId: string;
  type: string;
  payload: unknown;
}

export interface ConsoleHumanInputResolved extends ConsoleEnvelope {
  type: "HUMAN_INPUT_RESOLVED";
  payload: {
    sessionId: string;
    toolUseId: string;
    status:
      "approved" | "rejected" | "context_added" | "answered" | "continued";
    resolvedBy?: string;
    resolvedAt?: string;
  };
}

export type ConsoleInterruptResolved = ConsoleHumanInputResolved;

// Ephemeral token delta — never persisted, only rides the in-process event bus.
export interface ConsoleTextMessageContent extends ConsoleEnvelope {
  type: "TEXT_MESSAGE_CONTENT";
  payload: {
    sessionId: string;
    kind: "text" | "thinking";
    delta: string;
  };
}

// A single persisted transcript row landed; the console appends it. Fires once
// per message, many times per run - purely a content event, never a lifecycle one.
export interface ConsoleMessage extends ConsoleEnvelope {
  type: "MESSAGE";
  payload: {
    sessionId: string;
    message: SessionMessage;
  };
}

// The one terminal event for a run that finished on its own (the model stopped
// with no tool call). Exactly one per completed run; stopped/failed/suspended
// runs end via their own distinct terminal events instead.
export interface ConsoleRunFinished extends ConsoleEnvelope {
  type: "RUN_FINISHED";
  payload: {
    sessionId: string;
    reason: "completed";
  };
}

// A card the API has built, to insert or replace by its key. The same projection
// serves the transcript fetch, so a live card and a reloaded one cannot differ.
export interface ConsoleTranscriptItem extends ConsoleEnvelope {
  type: "TRANSCRIPT_ITEM";
  payload: {
    sessionId: string;
    item: TranscriptItem;
  };
}

// Gated tool paused for approval or clarification. Resolved via POST /sessions/:id/respond.
export interface ConsoleHumanInputRequired extends ConsoleEnvelope {
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

export type ConsoleInterrupt = ConsoleHumanInputRequired;

export interface ConsoleRunStopped extends ConsoleEnvelope {
  type: "RUN_STOPPED";
  payload: {
    sessionId: string;
  };
}

// Sandbox provisioning progress (clone, container start, dependency install)
// so the first repo tool call never looks hung. Ephemeral status only -
// nothing is persisted.
export interface ConsoleSandboxStatus extends ConsoleEnvelope {
  type: "SANDBOX_STATUS";
  payload: {
    sessionId: string;
    stage: "cloning" | "starting" | "installing" | "ready" | "failed";
  };
}

// A transient provider error mid-run: the run is waiting out a backoff delay,
// not dead. Ephemeral status only - nothing is persisted.
export interface ConsoleRunRetrying extends ConsoleEnvelope {
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
// console appends it to the transcript exactly like a MESSAGE event.
export interface ConsoleRunFailed extends ConsoleEnvelope {
  type: "RUN_FAILED";
  payload: {
    sessionId: string;
    message: SessionMessage;
  };
}

// A concise title generated asynchronously once the run starts; patches the
// sidebar list in place (the durable title is written to the sessions row).
export interface ConsoleSessionTitleUpdated extends ConsoleEnvelope {
  type: "SESSION_TITLE_UPDATED";
  payload: {
    sessionId: string;
    title: string;
  };
}

// The session's stored report changed (agent update mid-run, or the finish gate
// finalized it). Content event like MESSAGE, fires many times per run; carries
// only the id - the console refetches the report.
export interface ConsoleReportUpdated extends ConsoleEnvelope {
  type: "REPORT_UPDATED";
  payload: {
    sessionId: string;
  };
}

// Discriminated union of all events on the API→console SSE stream.
// Narrowing on `type` gives callers a typed `payload` for free.
export type ConsoleEvent =
  | ConsoleTranscriptItem
  | ConsoleTextMessageContent
  | ConsoleMessage
  | ConsoleRunFinished
  | ConsoleHumanInputRequired
  | ConsoleHumanInputResolved
  | ConsoleRunStopped
  | ConsoleSandboxStatus
  | ConsoleRunRetrying
  | ConsoleRunFailed
  | ConsoleSessionTitleUpdated
  | ConsoleReportUpdated;
