// Two parts, two authors, two moments: the hypotheses the agent appends to as
// it works, and the report written once at the end over a complete set of them.

import type { HumanDecision, ToolOutcome } from "./messages.js";

// Five, because without a home for "symptom of something upstream" the model
// must overclaim or say nothing. Recorded once tested, so there is no "open".
export type Verdict =
  "root_cause" | "trigger" | "symptom" | "contributing_factor" | "disproven";

// How well the system can back a claim, computed from the trail at read time.
// A claim with no resolvable citation earns none of these.
export type Conviction = "cited" | "corroborated" | "verified";

export interface Hypothesis {
  // Assigned by the system in recording order, so a later call cannot land on an
  // earlier row and rewrite it.
  id: string;
  statement: string;
  verdict: Verdict;
  // The id of the claim this one replaces, when it replaces one. A link rather
  // than an edit: the replaced claim stays on the record beside it.
  supersedes?: string;
  // Why it resolved that way. Deliberately not "reason": since the reason rides
  // the write call, that word means one thing across the whole contract.
  finding: string;
  // Evidence ids, copied verbatim. Ids naming no real call are dropped; the
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

// Every claim another one replaced. They stay on the record and stay rendered;
// what they lose is the ability to lead.
export function supersededIds(hypotheses: Hypothesis[]): Set<string> {
  return new Set(
    hypotheses.flatMap((h) =>
      h.supersedes === undefined ? [] : [h.supersedes],
    ),
  );
}

// What the run currently stands behind, or null when it stands behind nothing.
export function leadingHypothesis(hypotheses: Hypothesis[]): Hypothesis | null {
  const replaced = supersededIds(hypotheses);
  return (
    rankHypotheses(hypotheses).find(
      (h) => h.verdict !== "disproven" && !replaced.has(h.id),
    ) ?? null
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
    toolOutcome?: ToolOutcome;
  };
}

// Written in one call over complete claims, and it restates none of them: this
// is the prose they have nowhere to put.
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

// Everything one investigation holds, in the two parts above. Named apart from
// the report inside it, because for a long time one word meant both.
export interface InvestigationRecord {
  hypotheses: Hypothesis[];
  // Null until the run reaches its composition turn, which several endings
  // never do: the hypotheses render without it.
  report: SubmittedReport | null;
  updatedAt: string;
}

// Declared on the tool so the console looks a renderer up rather than sniffing
// the result: a declaration cannot drift from what the tool returns.
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
  // A cited miss is often the evidence itself, while a cited crash proves
  // nothing: the report must not read the two the same way.
  toolOutcome?: ToolOutcome;
  // Present only where a person was asked. A cited call they declined never ran,
  // which is a different thing again from one that ran and found nothing.
  humanDecision?: HumanDecision;
}

// Computed from the trail on every read and never stored, so no tool input can
// set it. Keyed by hypothesis id; a row absent from it earned no conviction.
export type ReportConviction = Record<string, Conviction>;

// Who decided is not recorded: there is one user, and a multi-tenant build
// would get the name from the session that approved it.
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
  toolOutcome?: ToolOutcome;
  // Only worth reading on a failure: a success is its own output, which the
  // transcript already shows.
  result: string | null;
}

// The report route's response. Three authors, deliberately: the model writes
// `record`, the transcript answers `decisions` and `evidence`, the system
// computes `conviction`.
export interface SessionReportResponse {
  record: InvestigationRecord;
  decisions: GatedCall[];
  evidence: ResolvedEvidence[];
  conviction: ReportConviction;
}
