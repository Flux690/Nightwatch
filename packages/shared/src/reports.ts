// Two parts, two authors, two moments: the ledger the agent appends to as it
// works, and the report written once at the end over a ledger already complete.

import type { HumanDecision, ToolOutcome } from "./messages.js";

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

// Most confident first. `disproven` sorts last and never leads: it is what the
// run ruled out, not what it concluded.
const VERDICT_ORDER: readonly Verdict[] = [
  "root_cause",
  "trigger",
  "contributing_factor",
  "symptom",
  "disproven",
];

/* One ordering, so the queue row and the report cannot name different leading
   claims. Equal confidence breaks on recording order, newest first: that is the
   conclusion the run reached after the most work. */
export function rankHypotheses(hypotheses: Hypothesis[]): Hypothesis[] {
  return hypotheses
    .map((hypothesis, recorded) => ({ hypothesis, recorded }))
    .sort(
      (a, b) =>
        VERDICT_ORDER.indexOf(a.hypothesis.verdict) -
          VERDICT_ORDER.indexOf(b.hypothesis.verdict) ||
        b.recorded - a.recorded,
    )
    .map(({ hypothesis }) => hypothesis);
}

// What the run currently stands behind, or null when it stands behind nothing.
export function leadingHypothesis(hypotheses: Hypothesis[]): Hypothesis | null {
  return (
    rankHypotheses(hypotheses).find((h) => h.verdict !== "disproven") ?? null
  );
}

// Which strand of the incident a moment belongs to. `action` is absent here
// because it is not the model's to claim: a released write is contributed by the
// system, and carries `action` below instead.
export type TimelineLane = "change" | "signal" | "agent";

// One moment in what happened. The model authors these; the system contributes
// a row for every released write, so an action cannot be left off a timeline
// the model did not author in full.
export interface TimelineEntry {
  at: string;
  what: string;
  // Which lane draws it. Absent on a system row, and on any report written
  // before the field existed.
  lane?: TimelineLane;
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
  // One sentence, the whole answer. `summary` was doing headline and deck at
  // once and was good at neither. Empty on a report written before it existed.
  headline?: string;
  // A short noun phrase naming who was hit. Written by the model today; a blast
  // radius derived from downstream edges once the topology graph can compute one.
  affected?: string;
  // What broke, why, and where it stands now. The lede.
  summary: string;
  timeline: TimelineEntry[];
  impact: string;
  // What the user should do. Never a claim that anything has been done -
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

/* So the console looks a renderer up rather than sniffing the result's shape.
   Declared on the tool, never guessed: a declaration cannot drift from what the
   tool returns, a shape test can. Coarser than the renderers on purpose. */
export type EvidenceKind =
  "metric" | "logs" | "change" | "state" | "diff" | "text";

// One cited tool call, resolved from the transcript at read time so the report
// quotes what ran rather than storing a second copy of it.
export interface ResolvedEvidence {
  toolUseId: string;
  toolName: string;
  kind: EvidenceKind;
  input: Record<string, unknown>;
  result: string;
  // Absent when the call answered. A cited miss is often the evidence itself -
  // the file really is not there - while a cited crash proves nothing about the
  // fleet, and the report must not read the two the same way.
  outcome?: ToolOutcome;
  // Present only where a person was asked. A cited call they declined never ran,
  // which is a different thing again from one that ran and found nothing.
  humanDecision?: HumanDecision;
}

// Computed from the ledger on every read and never stored, so no tool input can
// set it. Keyed by hypothesis id; a row absent from it earned no conviction.
export type ReportConviction = Record<string, Conviction>;

// A gated call and what the user did with it, read back from the session's
// own transcript. Who decided is not recorded: there is one user, and a
// multi-tenant build gets the name from the session that approved it.
export interface GatedCall {
  toolUseId: string;
  toolName: string;
  // The service the write addressed, absent on a tool that names no target.
  target: string | null;
  // When it answered, which is what places it on the timeline.
  at: string;
  decision: "approved" | "rejected";
  // Present only on a call that did not simply answer, and always the API's own
  // reading of the tool: what the person said is `decision` above.
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
