import type { AlertSeverity, NormalizedAlert } from "./alerts.js";
import type { MessagePart, NativeEnvelope } from "./messages.js";
import type { TranscriptItem } from "./transcript.js";

// A session is the agent's conversation thread (the durable parent); an incident is an optional
// artifact referencing it. Sessions live in the API's SQLite, id minted at trigger time, appended per turn.

// Who wrote a row. Four kinds against a provider's two roles: "error" is our own
// note, rendered but never replayed; "nightwarden" is the harness talking to the
// model, replayed as a user turn but never rendered. buildSeed maps them.
export type TranscriptKind = "user" | "assistant" | "error" | "nightwarden";

// Row state for the sessions queue, derived server-side and never declared by
// the model. A row no word applies to says nothing, which is why the field is
// nullable rather than carrying a sixth value.
export type SessionRunStatus =
  "action_required" | "investigating" | "resolved" | "inconclusive" | "failed";

// One row of the console's one session list. A session not under investigation
// leaves the status fields null.
export interface SessionListRow extends SessionMeta {
  lastActivityAt: string;
  investigation: boolean;
  // The rank, for ordering. Null when the label named a word we cannot rank.
  severity: AlertSeverity | null;
  // The label's own word, for rendering. Null when the alert carries no label.
  severityLabel: string | null;
  status: SessionRunStatus | null;
  // One line answering the question the status raises, drawn from the system's
  // record or the model's prose. Null when there is nothing to say.
  finding: string | null;
  // Its own field rather than a reading of `status`, which is null unless the
  // session is under investigation - any session can be waiting on a human.
  awaitingHumanInput: boolean;
}

// What GET /sessions answers. The rows are one page; the counts are claims
// about every session, which a page cannot answer.
export interface SessionListPage {
  rows: SessionListRow[];
  // The offset to request next, or null once the list is exhausted.
  nextOffset: number | null;
  // Every investigation there is, so a record's place in the queue is true.
  investigationTotal: number;
}

// Two pages over one table. Without it a page of results can be entirely the
// other kind, and pagination stops meaning anything.
export type SessionKind = "investigation" | "chat";

export interface SessionMeta {
  sessionId: string;
  title: string;
  createdAt: string;
}

// One alert on a session, with the facts the alert itself cannot carry: when it
// joined, whether the condition has since recovered, and how it got here.
export interface SessionAlert {
  alert: NormalizedAlert;
  arrivedAt: string;
  clearedAt: string | null;
  // True when it arrived mid-run rather than opening the session. Recorded when
  // the row is written, because that is when it is known.
  injected: boolean;
  // How many alerts the source left out of the delivery this one arrived in.
  // Zero is the ordinary case and means the group was sent whole.
  droppedAlerts: number;
}

// What GET /sessions/:id answers. The session states whether it is under
// investigation itself, so no consumer infers it from a run's leftovers.
export interface SessionDetail extends SessionMeta {
  investigation: boolean;
  // Whether a run is in flight right now. The stream carries the deltas; without
  // this the snapshot has three endings and no beginning, so a session rejoined
  // mid-run reads as idle until the next event happens to land.
  running: boolean;
  // In arrival order: the batch that opened the session, then any that arrived
  // while the run was working.
  alerts: SessionAlert[];
  transcript: TranscriptItem[];
}

// One row of a session's transcript. Most are conversation turns; some are not,
// which is what `kind` answers.
export interface TranscriptRow {
  sessionId: string;
  seq: number;
  kind: TranscriptKind;
  // Human-readable rendering, derived from parts. Titles and list rows read it.
  content: string;
  // The turn's portable content. Empty on "error" rows, which are our own notes
  // rather than a model turn.
  parts: MessagePart[];
  // The vendor's own message, replayed verbatim when the dialect still matches -
  // parts alone can't restore a signed thinking block.
  native?: NativeEnvelope;
  timestamp: string;
}
