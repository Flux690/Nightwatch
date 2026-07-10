import type { SessionMessage } from "./sessions.js";

// Common envelope for the API→console event stream (SSE). messageId is a
// per-event UUID inside the payload JSON; it is not an SSE `id:` field - the
// feed is deliberately drop-tolerant and has no Last-Event-ID replay.
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
      | "approved"
      | "rejected"
      | "context_added"
      | "answered"
      | "continued";
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

export interface ConsoleRunFinished extends ConsoleEnvelope {
  type: "RUN_FINISHED";
  payload: {
    sessionId: string;
    message: SessionMessage;
  };
}

export interface ConsoleToolCallStart extends ConsoleEnvelope {
  type: "TOOL_CALL_START";
  payload: {
    sessionId: string;
    toolUseId: string;
    toolName: string;
    input: Record<string, unknown>;
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

export interface ConsoleToolCallEnd extends ConsoleEnvelope {
  type: "TOOL_CALL_END";
  payload: {
    sessionId: string;
    toolUseId: string;
    result: unknown;
    isError?: boolean;
  };
}

export interface ConsoleRunStopped extends ConsoleEnvelope {
  type: "RUN_STOPPED";
  payload: {
    sessionId: string;
  };
}

// An investigation threw an unexpected error and ended without finishing. Tells
// the console to surface the failure instead of leaving the run looking idle.
export interface ConsoleRunFailed extends ConsoleEnvelope {
  type: "RUN_FAILED";
  payload: {
    sessionId: string;
    message: string;
  };
}

// Discriminated union of all events on the API→console SSE stream.
// Narrowing on `type` gives callers a typed `payload` for free.
export type ConsoleEvent =
  | ConsoleTextMessageContent
  | ConsoleRunFinished
  | ConsoleToolCallStart
  | ConsoleHumanInputRequired
  | ConsoleToolCallEnd
  | ConsoleHumanInputResolved
  | ConsoleRunStopped
  | ConsoleRunFailed;
