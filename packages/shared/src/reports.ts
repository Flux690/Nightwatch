// The investigation report: a durable, structured artifact the agent maintains
// live during an Investigate run via the UpdateReport tool. Stored one-per-session.
// It holds only what the model authored; everything the operator reads about the
// evidence is resolved from the transcript, which is the record of what ran.

import type { RemediationActionRecord } from "./remediation.js";
import type { ToolOutcome } from "./transcript.js";

export type ReportStatus =
  "root_cause_identified" | "inconclusive" | "investigation_incomplete";
export type HypothesisState = "root_cause" | "disproven" | "open";
export type Confidence = "low" | "medium" | "high";

export interface Hypothesis {
  id: string;
  statement: string;
  state: HypothesisState;
  confidence: Confidence;
  reason: string;
  // The ids of the tool calls that back this claim, copied verbatim. Ids naming
  // no call in this session are dropped; the claim itself always survives.
  evidenceIds: string[];
}

export interface Report {
  status: ReportStatus;
  // Short investigation title; supersedes the session title in the UI.
  headline: string;
  rootCause: { summary: string; detail: string };
  hypotheses: Hypothesis[];
  // What the agent RECOMMENDS, never a claim that anything ran. What actually
  // ran is the executed action log, which the model cannot write to.
  recommendedFix: { summary: string; evidenceIds: string[] };
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

// The report route's response. The three halves have three different authors
// and that is the point: the model writes `report`, the executor writes
// `actions`, and `evidence` is the transcript quoting itself.
export interface SessionReportResponse {
  report: Report;
  actions: RemediationActionRecord[];
  evidence: ResolvedEvidence[];
}
