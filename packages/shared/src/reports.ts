// The investigation record: append-only rows the agent writes one act at a time.
// It holds only what the model authored; status, conviction, the evidence and
// what ran are all answered by the system.

import type { RemediationActionRecord } from "./remediation.js";
import type { ToolOutcome } from "./transcript.js";

// How a hypothesis resolved, plus "open" while it is still being tested. Six,
// because without a home for "symptom of something upstream" the model must
// overclaim a root cause or leave the question open.
export type Verdict =
  | "root_cause"
  | "trigger"
  | "symptom"
  | "contributing_factor"
  | "disproven"
  | "open";

// How well the system can back a claim, computed from the ledger at read time.
// A claim with no resolvable citation earns none of these.
export type Conviction = "cited" | "corroborated" | "verified";

export interface Hypothesis {
  // Assigned by the system in proposal order, so a later call cannot land on an
  // earlier row and rewrite it.
  id: string;
  statement: string;
  verdict: Verdict;
  // Why it resolved that way. Deliberately not "reason": since the reason rides
  // the write call, that word means one thing across the whole contract.
  finding: string;
  // Ledger entry ids, copied verbatim. Ids naming no call in this session are
  // dropped; the claim itself always survives.
  evidenceIds: string[];
  proposedAt: string;
  resolvedAt: string | null;
}

// What the agent RECOMMENDS, never a claim that anything ran. What actually ran
// is the executed action log, which the model cannot write to.
export interface ProposedFix {
  id: string;
  summary: string;
  evidenceIds: string[];
  recordedAt: string;
}

// A rejection redirects the agent rather than stopping it, so it proposes again.
// The list keeps both: the last one is what stands, and the ones before it are
// what the operator turned down.
export interface Report {
  hypotheses: Hypothesis[];
  fixes: ProposedFix[];
  updatedAt: string;
  model: string;
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
// set it. Keyed by row id across both hypotheses and fixes, whose ids share one
// namespace; a row absent from it earned no conviction at all.
export type ReportConviction = Record<string, Conviction>;

// The report route's response. Four authors, deliberately: the model writes
// `report`, the executor `actions`, the transcript `evidence`, the system
// `conviction`.
export interface SessionReportResponse {
  report: Report;
  actions: RemediationActionRecord[];
  evidence: ResolvedEvidence[];
  conviction: ReportConviction;
}
