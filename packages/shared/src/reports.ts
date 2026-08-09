// The investigation record, in two parts with two authors and two moments. The
// ledger is rows the agent appends as it works; the composed report is written
// once at the end, over the ledger, and adds only what the ledger has no field
// for. Status, conviction, the evidence and what ran are all answered by the
// system.

import type { ToolOutcome } from "./transcript.js";

// How a hypothesis resolved. Five, because without a home for "symptom of
// something upstream" the model must overclaim a root cause or say nothing. A
// hypothesis is recorded once it has been tested, so there is no "open".
export type Verdict =
  "root_cause" | "trigger" | "symptom" | "contributing_factor" | "disproven";

// How well the system can back a claim, computed from the ledger at read time.
// A claim with no resolvable citation earns none of these.
export type Conviction = "cited" | "corroborated" | "verified";

export interface Hypothesis {
  // Assigned by the system in recording order, so a later call cannot land on an
  // earlier row and rewrite it.
  id: string;
  statement: string;
  verdict: Verdict;
  // Why it resolved that way. Deliberately not "reason": since the reason rides
  // the write call, that word means one thing across the whole contract.
  finding: string;
  // Ledger entry ids, copied verbatim. Ids naming no real call are dropped; the
  // claim itself always survives.
  evidenceIds: string[];
  recordedAt: string;
}

// One moment in what happened. The model authors these; the system contributes
// a row for every released write, so an action cannot be left off a timeline
// the model did not author in full.
export interface TimelineEntry {
  at: string;
  what: string;
  // The call that shows this happened, when one does.
  evidenceId?: string;
  // Absent on the model's own entries. Present on a system row, which names the
  // tool that ran rather than describing it.
  action?: {
    toolName: string;
    target: string | null;
    decision: "approved" | "rejected";
    outcome?: ToolOutcome;
  };
}

// Written in one call at the end of a run, over a ledger that is already
// complete. Nothing here restates the ledger: no verdicts, no hypotheses, no
// re-copied citations. It is the prose the ledger has nowhere to put.
export interface SubmittedReport {
  // What broke, why, and where it stands now. The lede.
  summary: string;
  timeline: TimelineEntry[];
  impact: string;
  // What the operator should do. Never a claim that anything has been done -
  // what ran is the released-write log, which the model cannot write to.
  recommendation: string;
  submittedAt: string;
}

export interface Report {
  hypotheses: Hypothesis[];
  // Null until the run reaches its composition turn, which several endings
  // never do: the ledger renders on its own.
  submitted: SubmittedReport | null;
  updatedAt: string;
}

// One cited tool call, resolved from the transcript at read time so the report
// quotes what ran rather than storing a second copy of it.
export interface ResolvedEvidence {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  result: string;
  // Absent when the call answered. A cited miss is often the evidence itself -
  // the file really is not there - while a cited crash proves nothing about the
  // fleet, and the report must not read the two the same way.
  outcome?: ToolOutcome;
}

// Computed from the ledger on every read and never stored, so no tool input can
// set it. Keyed by hypothesis id; a row absent from it earned no conviction.
export type ReportConviction = Record<string, Conviction>;

// A gated call and what the operator did with it, read back from the session's
// own transcript. Who decided is not recorded: there is one operator, and a
// multi-tenant build gets the name from the session that approved it.
export interface GatedCall {
  toolUseId: string;
  toolName: string;
  // The service the write addressed, absent on a tool that names no target.
  target: string | null;
  // When it answered, which is what places it on the timeline.
  at: string;
  decision: "approved" | "rejected";
  // Present only on a call that did not simply answer; `rejected` is the class a
  // human authored, every other member the API's own reading.
  outcome?: ToolOutcome;
  // Only worth reading on a failure: a success is its own output, which the
  // transcript already shows.
  result: string | null;
}

// The report route's response. Three authors, deliberately: the model writes
// `report`, the transcript answers `decisions` and `evidence`, the system
// computes `conviction`.
export interface SessionReportResponse {
  report: Report;
  decisions: GatedCall[];
  evidence: ResolvedEvidence[];
  conviction: ReportConviction;
}
