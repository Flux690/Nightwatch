// WebSocket message envelope types — runner↔api and api↔console

export type MessageDirection = "api_to_runner" | "runner_to_api" | "api_to_console" | "console_to_api";

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
    installationId: string;
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
