export type MessageDirection =
  | "api_to_runner"
  | "runner_to_api"
  | "api_to_console"
  | "console_to_api";

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

// API → Runner: replace the runner's Prometheus alert rules and reload.
// Settings, not remediation — does not pass through the approval gate.
export interface UpdateAlertRulesCommand {
  commandName: "update_alert_rules";
  commandInput: { rulesYaml: string };
  correlationId: string;
}

// API → Runner: update the in-memory remediation mode (fire-and-forget).
// The runner applies it immediately and reports it in subsequent manifests.
// Reconciliation: the API pushes this whenever a manifest disagrees with DB.
export interface SetRemediationModeMessage extends WsEnvelope {
  type: "set_remediation_mode";
  payload: { enabled: boolean };
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
