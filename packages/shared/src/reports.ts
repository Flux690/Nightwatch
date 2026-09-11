// Three parts, three authors, three moments: the candidates the agent opens as
// it reasons, the findings it appends as it settles them, and the report at the end.

// Six, so a run has a home for "I had no way to test it" apart from "I tested it
// and it is false". Recorded once tested, so there is no "open" finding.
export type Verdict =
  | "root_cause"
  | "trigger"
  | "symptom"
  | "contributing_factor"
  | "disproven"
  | "untestable";

// A hypothesis the agent commits to before testing it, carrying what it expects
// to see if it holds and what would prove it wrong.
export interface Candidate {
  // c1, c2..., assigned by the system in opening order.
  id: string;
  statement: string;
  // The observation expected if the candidate is true.
  ifTrue: string;
  // The observation that would prove it false.
  ifFalse: string;
  // The candidate this one explains, when it goes a step deeper into a cause.
  parent?: string;
}

export interface Finding {
  // f1, f2..., assigned by the system in recording order, so a later call cannot
  // land on an earlier row and rewrite it.
  id: string;
  statement: string;
  verdict: Verdict;
  // The candidate this finding settles, when it settles one.
  settles?: string;
  // The id of the finding this one replaces, when it replaces one. A link rather
  // than an edit: the replaced finding stays on the record beside it.
  supersedes?: string;
  // What the cited results showed, and why they settle it this way.
  explanation: string;
  evidenceIds: string[];
  recordedAt: string;
}

// Most confident first. `disproven` and `untestable` sort last and never lead:
// one is what the run ruled out, the other what it could not reach.
const VERDICT_ORDER: readonly Verdict[] = [
  "root_cause",
  "trigger",
  "contributing_factor",
  "symptom",
  "disproven",
  "untestable",
];

/* One ordering, so the queue row and the report cannot name different leading
   findings. Equal confidence breaks newest first, after the most work. */
export function rankFindings(findings: Finding[]): Finding[] {
  return findings
    .map((finding, recorded) => ({ finding, recorded }))
    .sort(
      (a, b) =>
        VERDICT_ORDER.indexOf(a.finding.verdict) -
          VERDICT_ORDER.indexOf(b.finding.verdict) || b.recorded - a.recorded,
    )
    .map(({ finding }) => finding);
}

// Every finding another one replaced. They stay on the record and stay rendered;
// what they lose is the ability to lead.
export function supersededIds(findings: Finding[]): Set<string> {
  return new Set(
    findings.flatMap((f) => (f.supersedes === undefined ? [] : [f.supersedes])),
  );
}

// Every standing finding at the best verdict rank present, so a multi-factor
// cause is not narrowed to one. Empty when the run stands behind nothing.
export function principalFindings(findings: Finding[]): Finding[] {
  const replaced = supersededIds(findings);
  const standing = rankFindings(findings).filter(
    (f) =>
      f.verdict !== "disproven" &&
      f.verdict !== "untestable" &&
      !replaced.has(f.id),
  );
  const top = standing[0];
  return top === undefined
    ? []
    : standing.filter((f) => f.verdict === top.verdict);
}

// `action` is absent because it is not the model's to claim: the system
// contributes a released write, carrying `action` below.
export type TimelineLane = "change" | "signal" | "agent";

// The model authors these; the system adds a row per released write, so an
// action cannot be left off a timeline the model did not author in full.
export interface TimelineEntry {
  at: string;
  what: string;
  // Which lane draws it. Absent on a system row, which the model does not write.
  lane?: TimelineLane;
  // The call that shows this happened, when one does.
  evidenceId?: string;
  // Absent on the model's own entries. Present on a system row, which names the
  // tool that ran rather than describing it.
  action?: {
    toolName: string;
    target: string | null;
    decision: "approved" | "rejected";
    isError?: boolean;
  };
}

// Written in one call over complete findings, and it restates none of them: this
// is the prose they have nowhere to put.
export interface SubmittedReport {
  // One sentence, the whole answer: headline and deck are two jobs, and one
  // field doing both is good at neither.
  headline: string;
  // A short noun phrase naming who was hit. Written by the model today; a blast
  // radius derived from downstream edges once the topology graph can compute one.
  affected: string;
  // What broke, why, and where it stands now. The deck under the headline.
  summary: string;
  timeline: TimelineEntry[];
  impact: string;
  // What the user should do. Never a claim that anything has been done -
  // what ran is the released-write log, which the model cannot write to.
  recommendation: string;
  submittedAt: string;
  // Lets a later run ask whether the report is behind without reading a clock.
  // Stamped by the write that stores it, so it cannot overstate its coverage.
  findingsCoveredUpTo: string;
  writesCoveredUpTo: number;
}

// Everything one investigation holds. The candidates the run is weighing, the
// findings that settle them, and the report written once over a complete set.
export interface InvestigationRecord {
  candidates: Candidate[];
  findings: Finding[];
  // The candidate ids named in the last frontier message, so a resumed run does
  // not restate a frontier it already sent.
  lastStatedCandidates: string[];
  // Null until the run reaches its composition turn, which several endings never
  // do: the findings render without it.
  report: SubmittedReport | null;
  updatedAt: string;
}

// Declared on the tool so the frontend picks a renderer rather than guessing
// from the result: a declaration cannot drift from what the tool returns.
export type EvidenceKind =
  | "metric"
  | "logs"
  | "change"
  | "state"
  | "diff"
  | "terminal"
  | "exception"
  | "text";

// One cited tool call, resolved from the transcript at read time so the report
// quotes what ran rather than storing a second copy of it.
export interface ResolvedEvidence {
  // Two ids, because a claim cites one and the frontend reveals the other.
  evidenceId: string;
  toolCallId: string;
  toolName: string;
  kind: EvidenceKind;
  input: Record<string, unknown>;
  result: string;
  // Present only where a person was asked, since a declined call never ran.
  approved?: boolean;
}

// Who decided is not recorded: there is one user, and a multi-tenant build
// would get the name from the session that approved it.
export interface GatedCall {
  toolCallId: string;
  toolName: string;
  // The service the write addressed, absent on a tool that names no target.
  target: string | null;
  // When it answered, which is what places it on the timeline.
  at: string;
  decision: "approved" | "rejected";
  // The API's reading of the tool; what the person said is `decision` above.
  isError?: boolean;
  // Only worth reading on a failure: a success is its own output, which the
  // transcript already shows.
  result: string | null;
}

// Two authors: the model writes `record`, and the transcript answers both
// `decisions` and `evidence`.
export interface SessionReportResponse {
  record: InvestigationRecord;
  decisions: GatedCall[];
  evidence: ResolvedEvidence[];
}
