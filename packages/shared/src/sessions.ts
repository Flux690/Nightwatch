// A session is the agent's conversation thread (the durable parent); an incident is an optional
// artifact referencing it. Sessions live in the API's SQLite, id generated at trigger time, appended per turn.

import type { AlertGroupContext, NormalizedAlert } from "./alerts.js";
import type { MessagePart, NativeEnvelope } from "./messages.js";
import type { TranscriptItem } from "./transcript.js";

// Four kinds against a provider's two roles: "error" is rendered but never
// replayed, "harness" replayed but never rendered. buildSeed maps them.
export type TranscriptKind = "user" | "assistant" | "error" | "harness";

// Derived server-side and never declared by the model. The frontend draws
// `running` as "Investigating"; null on a chat, which has no status to show.
export type InvestigationStatus =
  | "action_required"
  | "running"
  | "resolved"
  | "stopped"
  | "failed"
  | "completed";

// One row of the frontend's one session list. A session not under investigation
// leaves the status fields null.
export interface SessionListRow extends SessionMeta {
  lastActivityAt: string;
  investigation: boolean;
  // Whatever the sender called it, verbatim. Null when it carried no label.
  severityLabel: string | null;
  status: InvestigationStatus | null;
  // One line answering the question the status raises, drawn from the system's
  // record or the model's prose. Null when there is nothing to say.
  statusLine: string | null;
  // Its own field rather than a reading of `status`, which is null unless the
  // session is under investigation - any session can be waiting on a human.
  awaitingHumanInput: boolean;
}

// Alerts waiting for a seat and the pool they wait on, never sessions: nothing
// has investigated them yet.
export interface QueueState {
  waiting: number;
  running: number;
  limit: number;
  // ISO timestamp of the longest-waiting alert, null when nothing waits.
  oldestArrivedAt: string | null;
}

// What GET /sessions answers. The rows are one page; the counts are claims
// about every session, which a page cannot answer.
export interface SessionListPage {
  rows: SessionListRow[];
  // The offset to request next, or null once the list is exhausted.
  nextOffset: number | null;
  // Every investigation there is, so a record's place in the queue is true.
  investigationTotal: number;
  // Seeded here rather than only pushed, or a reload draws no band at all.
  queue: QueueState;
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
  // What that delivery said about the group as a whole. Null when the sender
  // supplied none of it.
  groupContext: AlertGroupContext | null;
}

// What GET /sessions/:id answers. The session states whether it is under
// investigation itself, so no consumer infers it from a run's leftovers.
export interface SessionDetail extends SessionMeta {
  investigation: boolean;
  // The last thing that happened on it. There is no end time to store - a run
  // can die without writing one - so this is what a finished record is timed to.
  lastActivityAt: string;
  // The stream carries the deltas, so without this a session rejoined mid-run
  // reads as idle until the next event happens to land.
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
