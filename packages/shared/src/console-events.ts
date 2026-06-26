import type { WsEnvelope } from "./ws.js";
import type { SessionMessage } from "./sessions.js";

export interface ConsoleHumanInputResolved extends WsEnvelope {
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
export interface ConsoleTextMessageContent extends WsEnvelope {
  type: "TEXT_MESSAGE_CONTENT";
  payload: {
    sessionId: string;
    kind: "text" | "thinking";
    delta: string;
  };
}

export interface ConsoleRunFinished extends WsEnvelope {
  type: "RUN_FINISHED";
  payload: {
    sessionId: string;
    message: SessionMessage;
  };
}

export interface ConsoleToolCallStart extends WsEnvelope {
  type: "TOOL_CALL_START";
  payload: {
    sessionId: string;
    toolUseId: string;
    toolName: string;
    input: Record<string, unknown>;
  };
}

// Gated tool paused for approval or clarification. Resolved via POST /sessions/:id/respond.
export interface ConsoleHumanInputRequired extends WsEnvelope {
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

export interface ConsoleToolCallEnd extends WsEnvelope {
  type: "TOOL_CALL_END";
  payload: {
    sessionId: string;
    toolUseId: string;
    result: unknown;
    isError?: boolean;
  };
}

export interface ConsoleRunStopped extends WsEnvelope {
  type: "RUN_STOPPED";
  payload: {
    sessionId: string;
  };
}

// Discriminated union of all API→console WebSocket messages.
// Narrowing on `type` gives callers a typed `payload` for free.
export type ConsoleEvent =
  | ConsoleTextMessageContent
  | ConsoleRunFinished
  | ConsoleToolCallStart
  | ConsoleHumanInputRequired
  | ConsoleToolCallEnd
  | ConsoleHumanInputResolved
  | ConsoleRunStopped;
