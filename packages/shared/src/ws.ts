// WebSocket message envelope types — runner↔api and api↔console

import type { SessionMessage } from "./sessions.js";

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

// API → Runner: replace the runner's Prometheus alert rules and reload. Settings,
// not remediation - it does not pass through the approval gate. The API renders
// the threshold form into the final rules file; the runner writes it verbatim.
export interface UpdateAlertRulesCommand {
  commandName: "update_alert_rules";
  commandInput: { rulesYaml: string };
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
// AG-UI: INCIDENT_UPDATE
export interface ConsoleIncidentUpdate extends WsEnvelope {
  type: "INCIDENT_UPDATE";
  payload: {
    incidentId: string;
    token: string;
    status: string;
    rootCauseSummary?: string;
    awaitingApproval?: boolean;
  };
}

// API → Console: approval resolved (another user approved or rejected).
// AG-UI: INTERRUPT_RESOLVED — paired with the INTERRUPT that preceded it.
export interface ConsoleInterruptResolved extends WsEnvelope {
  type: "INTERRUPT_RESOLVED";
  payload: {
    incidentId: string;
    toolUseId: string;
    status: "approved" | "rejected" | "context_added";
    resolvedBy?: string;
    resolvedAt?: string;
  };
}

// API → Console: a live token delta from an in-progress turn. Ephemeral (rides
// the in-process event bus only); never persisted - the durable record is the
// ConsoleRunFinished message written when the turn completes.
// AG-UI: TEXT_MESSAGE_CONTENT
export interface ConsoleTextMessageContent extends WsEnvelope {
  type: "TEXT_MESSAGE_CONTENT";
  payload: {
    sessionId: string;
    kind: "text" | "thinking";
    delta: string;
  };
}

// API → Console: a completed turn, mirroring what was persisted to the runner.
// AG-UI: RUN_FINISHED
export interface ConsoleRunFinished extends WsEnvelope {
  type: "RUN_FINISHED";
  payload: {
    sessionId: string;
    message: SessionMessage;
  };
}

// API → Console: a non-gated tool call started. The tool will execute
// immediately; TOOL_CALL_END arrives once the runner/platform responds.
// AG-UI: TOOL_CALL_START
export interface ConsoleToolCallStart extends WsEnvelope {
  type: "TOOL_CALL_START";
  payload: {
    sessionId: string;
    toolUseId: string;
    toolName: string;
    input: Record<string, unknown>;
  };
}

// API → Console: a gated tool call is paused awaiting human approval.
// The operator must approve before execution proceeds. incidentId addresses
// POST /incidents/:id/approve; toolUseId is the loop's correlation key.
// AG-UI: INTERRUPT
export interface ConsoleInterrupt extends WsEnvelope {
  type: "INTERRUPT";
  payload: {
    sessionId: string;
    toolUseId: string;
    toolName: string;
    input: Record<string, unknown>;
    incidentId: string;
  };
}

// API → Console: a tool call completed. Fires for both gated and non-gated
// tools once the runner/platform responds.
// AG-UI: TOOL_CALL_END
export interface ConsoleToolCallEnd extends WsEnvelope {
  type: "TOOL_CALL_END";
  payload: {
    sessionId: string;
    toolUseId: string;
    result: unknown;
    isError?: boolean;
  };
}

// API → Console: an investigation was escalated (the agent gave up and handed
// off to the human). Paired with a persisted incident record.
// AG-UI: ESCALATED
export interface ConsoleEscalated extends WsEnvelope {
  type: "ESCALATED";
  payload: {
    sessionId: string;
    incidentId: string;
    reason: string;
  };
}
