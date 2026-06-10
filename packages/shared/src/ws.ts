// WebSocket message envelope types — runner↔api and api↔console

import type { IncidentRecord } from "./incidents.js";
import type { SessionMessage, SessionMeta } from "./sessions.js";

export type MessageDirection =
  | "api_to_runner"
  | "runner_to_api"
  | "api_to_console"
  | "console_to_api";

// Runner ↔ API messages
export interface WsEnvelope {
  messageId: string;
  type: string;
  payload: unknown;
}

// API → Runner: send a command to execute
export interface RunnerCommandMessage extends WsEnvelope {
  type: "command";
  payload: {
    commandName: string;
    commandInput: Record<string, unknown>;
    correlationId: string; // tool_use_id from Anthropic SDK
  };
}

// API → Runner: persist a concluded incident to the runner's local SQLite history.
// Carried by a RunnerCommandMessage with commandName "write_incident".
export interface WriteIncidentCommand {
  commandName: "write_incident";
  commandInput: IncidentRecord;
  correlationId: string;
}

// API → Runner: append one transcript turn to the runner's session history. The
// session meta rides along on every call so the runner upserts it idempotently -
// the first append for a session creates the row, later ones just add messages.
export interface AppendSessionMessageCommand {
  commandName: "append_session_message";
  commandInput: {
    session: SessionMeta;
    message: SessionMessage;
  };
  correlationId: string;
}

// API → Runner: replace the runner's Prometheus alert rules and reload. Settings,
// not remediation - it does not pass through the approval gate. The API renders
// the threshold form into the final rules file; the runner writes it verbatim.
export interface UpdateAlertRulesCommand {
  commandName: "update_alert_rules";
  commandInput: { rulesYaml: string };
  correlationId: string;
}

// API → Runner: record a human's resolution note on a concluded incident (the
// feedback loop for an escalated incident a person resolved).
export interface ResolveIncidentCommand {
  commandName: "resolve_incident";
  commandInput: { incidentId: string; note: string };
  correlationId: string;
}

// Runner → API: capability manifest on connect
export interface RunnerManifestMessage extends WsEnvelope {
  type: "manifest";
  payload: import("./runner.js").CapabilityManifest;
}

// Runner → API: result of a command execution
export interface RunnerResultMessage extends WsEnvelope {
  type: "result";
  payload: {
    correlationId: string;
    success: boolean;
    result: unknown;
    error?: string;
  };
}

// Runner → API: heartbeat
export interface RunnerHeartbeatMessage extends WsEnvelope {
  type: "heartbeat";
  payload: { timestamp: string };
}

// API → Console: real-time incident update
export interface ConsoleIncidentUpdate extends WsEnvelope {
  type: "incident_update";
  payload: {
    incidentId: string;
    token: string;
    status: string;
    rootCauseSummary?: string;
    awaitingApproval?: boolean;
  };
}

// API → Console: approval state change (e.g. another user approved)
export interface ConsoleApprovalUpdate extends WsEnvelope {
  type: "approval_update";
  payload: {
    incidentId: string;
    toolUseId: string;
    status: "approved" | "rejected" | "context_added";
    resolvedBy?: string;
    resolvedAt?: string;
  };
}

// API → Console: a live token delta from an in-progress turn. Ephemeral (Redis
// pub/sub only, keyed by session); never persisted - the durable record is the
// ConsoleSessionMessage written when the turn completes.
export interface ConsoleSessionDelta extends WsEnvelope {
  type: "session_delta";
  payload: {
    sessionId: string;
    kind: "text" | "thinking";
    delta: string;
  };
}

// API → Console: a completed turn, mirroring what was persisted to the runner.
export interface ConsoleSessionMessage extends WsEnvelope {
  type: "session_message";
  payload: {
    sessionId: string;
    message: SessionMessage;
  };
}

// API → Console: a tool call's lifecycle within a session. `start` fires when the
// model invokes it (carrying input and, for gated tools, awaitingApproval);
// `result` fires once the runner/platform responds.
export interface ConsoleToolCall extends WsEnvelope {
  type: "tool_call";
  payload: {
    sessionId: string;
    toolUseId: string;
    toolName: string;
    phase: "start" | "result";
    input?: Record<string, unknown>;
    result?: unknown;
    isError?: boolean;
    awaitingApproval?: boolean;
    // The investigation this call belongs to. Present on the `start` event so the
    // console can address `POST /incidents/:id/approve` for a gated tool without a
    // second lookup. The toolUseId remains the loop's correlation key.
    incidentId?: string;
  };
}
