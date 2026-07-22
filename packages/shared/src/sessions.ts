import type { AlertSeverity } from "./alerts.js";

// A session is the agent's conversation thread (the durable parent); an incident is an optional
// artifact referencing it. Sessions live in the API's SQLite, id minted at trigger time, appended per turn.

// "error" rows are Nightwatch's own failure notes: shown in the transcript,
// never replayed to the model.
export type SessionRole = "user" | "assistant" | "error";

// How a run behaves: "investigate" adds the report tool and the finish gate;
// "ask" is a plain chat. Alerts always investigate; the mode is a one-way ratchet.
export type RunMode = "ask" | "investigate";

// Row state for the sessions queue, derived server-side in precedence order:
// pending human input, running, report terminal, error row, else stopped.
export type SessionRunStatus =
  | "action_required"
  | "investigating"
  | "resolved"
  | "inconclusive"
  | "failed"
  | "stopped";

// One row of the console's session list. Investigations carry queue fields;
// conversations leave them null. title is display-resolved (report headline
// supersedes the stored session title).
export interface SessionListRow extends SessionMeta {
  lastActivityAt: string;
  investigation: boolean;
  severity: AlertSeverity | null;
  target: string | null;
  status: SessionRunStatus | null;
  rootCauseLine: string | null;
}

export interface SessionMeta {
  sessionId: string;
  title: string;
  createdAt: string;
}

export interface SessionMessage {
  sessionId: string;
  seq: number;
  role: SessionRole;
  // Human-readable rendering for the console transcript.
  content: string;
  // Provider-native message kept verbatim so a resumed run rebuilds a valid turn - text alone can't
  // restore the thinking/tool_use/tool_result pairing. Opaque here; only the matching provider deserializes it.
  providerContent?: unknown;
  createdAt: string;
}
