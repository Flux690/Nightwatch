// The investigation report: a durable, structured artifact the agent maintains
// live during an Investigate run via the UpdateReport tool. Stored one-per-session.

import type { RemediationActionRecord } from "./remediation.js";

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
  // References EvidenceItem.id values on the same report.
  evidenceIds: string[];
}

// Metric evidence frozen into the report so it renders forever, even after the
// source's retention window expires. points are [iso, value].
export interface ChartSnapshot {
  seriesLabel: string;
  points: [string, number][];
}

export interface ChangesSnapshot {
  pullRequests: {
    number: number;
    title: string;
    author: string;
    mergedAt: string;
    url: string;
  }[];
}

export interface EvidenceItem {
  id: string;
  // Resolved server-side from the model's evidenceTag; "" when unresolvable.
  toolUseId: string;
  toolName: string;
  summary: string;
  chartSnapshot?: ChartSnapshot;
  changesSnapshot?: ChangesSnapshot;
}

export interface Report {
  status: ReportStatus;
  // Short investigation title; supersedes the session title in the UI.
  headline: string;
  rootCause: { summary: string; detail: string };
  hypotheses: Hypothesis[];
  evidence: EvidenceItem[];
  // What the agent RECOMMENDS, never a claim that anything ran. What actually
  // ran is the executed action log, which the model cannot write to.
  recommendedFix: { summary: string; evidenceIds: string[] };
  updatedAt: string;
  model: string;
}

// The report route's response. The two halves have different authors and that
// is the point: the model writes `report`, the executor writes `actions`.
export interface SessionReportResponse {
  report: Report;
  actions: RemediationActionRecord[];
}

// Row shape for the Sessions queue: derived from the stored report without
// shipping the whole document.
export interface ReportSummary {
  sessionId: string;
  status: ReportStatus;
  headline: string;
  rootCauseSummary: string;
}
