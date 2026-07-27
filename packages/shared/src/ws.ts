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
    correlationId: string; // random UUID minted per command by the API transport
  };
}

// API → Runner: the API's own container id, so the runner can keep the control
// plane out of everything it enumerates. Absent when the API is not containerized.
export interface HideContainerMessage extends WsEnvelope {
  type: "hide_container";
  payload: { containerId: string };
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
