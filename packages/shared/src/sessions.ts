import type { AlertSeverity, NormalizedAlert } from "./alerts.js";
import type { MessagePart, NativeEnvelope } from "./messages.js";
import type { TranscriptItem } from "./transcript.js";

// A session is the agent's conversation thread (the durable parent); an incident is an optional
// artifact referencing it. Sessions live in the API's SQLite, id minted at trigger time, appended per turn.

// "error" rows are NightWarden's own failure notes: shown in the transcript,
// never replayed to the model.
export type SessionRole = "user" | "assistant" | "error";

// Row state for the sessions queue, derived server-side in precedence order:
// pending human input, running, report terminal, error row, else stopped.
export type SessionRunStatus =
  | "action_required"
  | "investigating"
  | "resolved"
  | "inconclusive"
  | "failed"
  | "stopped";

// One row of the console's one session list. A session not under investigation
// leaves the status fields null. title is display-resolved (report headline
// supersedes the stored session title).
export interface SessionListRow extends SessionMeta {
  lastActivityAt: string;
  investigation: boolean;
  severity: AlertSeverity | null;
  status: SessionRunStatus | null;
  // Its own field rather than a reading of `status`, which is null unless the
  // session is under investigation - any session can be waiting on a human.
  awaitingHumanInput: boolean;
}

export interface SessionMeta {
  sessionId: string;
  title: string;
  createdAt: string;
}

// What GET /sessions/:id answers. The session states whether it is under
// investigation itself, so no consumer has to infer it from the artifacts a run
// happened to leave behind.
export interface SessionDetail extends SessionMeta {
  investigation: boolean;
  originatingAlert: NormalizedAlert | null;
  transcript: TranscriptItem[];
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
