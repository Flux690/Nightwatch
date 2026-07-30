import type { AlertSeverity } from "./alerts.js";
import type { MessagePart, NativeEnvelope } from "./messages.js";

// A session is the agent's conversation thread (the durable parent); an incident is an optional
// artifact referencing it. Sessions live in the API's SQLite, id minted at trigger time, appended per turn.

// "error" rows are NightWarden's own failure notes: shown in the transcript,
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
  status: SessionRunStatus | null;
  rootCauseLine: string | null;
  // Its own field rather than a reading of `status`, which is null on
  // conversations - an Ask session awaiting a clarification still needs you.
  awaitingHumanInput: boolean;
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
  // Human-readable rendering, derived from parts. Titles and list rows read it.
  content: string;
  // The turn's portable content. Empty on "error" rows, which are our own notes
  // rather than a model turn.
  parts: MessagePart[];
  // The vendor's own message, replayed verbatim when the dialect still matches -
  // parts alone can't restore a signed thinking block.
  native?: NativeEnvelope;
  createdAt: string;
}
