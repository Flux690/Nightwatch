import type {
  ChangesSnapshot,
  ChartSnapshot,
  EvidenceItem,
  Hypothesis,
  NormalizedAlert,
  Report,
  ReportStatus,
} from "@nightwarden/shared";
import { serviceIdentityKey } from "@nightwarden/shared";
import { getReport, upsertReport } from "../db/reports.js";
import { getSessionMessages } from "../db/sessions.js";
import { publishReportUpdated } from "../session/stream.js";
import type { GetRecentChangesResult } from "./tools/github.js";
import type { MetricsQueryResult } from "./tools/prometheus.js";
import type { PrometheusSeries } from "../integrations/prometheus.js";

// The report domain service: the ONLY place a report is saved, and the single
// owner of the evidence-tag format shared by result stamping and enrichment.

const EVIDENCE_TAG_SUFFIX = /\n\n\[evidence: e\d+\]$/;
const MAX_CHART_POINTS = 80;

export function evidenceTag(n: number): string {
  return `e${n}`;
}

export function stampEvidence(content: string, n: number): string {
  return `${content}\n\n[evidence: ${evidenceTag(n)}]`;
}

function stripEvidenceTag(content: string): string {
  return content.replace(EVIDENCE_TAG_SUFFIX, "");
}

export interface EvidenceIndexEntry {
  tag: string;
  toolUseId: string;
  toolName: string;
  resultContent: string | null;
}

// Walks the persisted transcript in order, numbering EVERY tool call (errored and
// gated included) so ordinals never shift, and pairing each with its result. The
// assistant turn is persisted before its tools execute, so the walk is current.
export function buildEvidenceIndex(sessionId: string): EvidenceIndexEntry[] {
  const entries: EvidenceIndexEntry[] = [];
  const byToolUseId = new Map<string, EvidenceIndexEntry>();
  for (const message of getSessionMessages(sessionId)) {
    for (const part of message.parts) {
      if (part.type === "tool_call") {
        const entry: EvidenceIndexEntry = {
          tag: evidenceTag(entries.length + 1),
          toolUseId: part.id,
          toolName: part.name,
          resultContent: null,
        };
        entries.push(entry);
        byToolUseId.set(part.id, entry);
      } else if (part.type === "tool_result") {
        const entry = byToolUseId.get(part.toolCallId);
        if (entry) entry.resultContent = stripEvidenceTag(part.output);
      }
    }
  }
  return entries;
}

// Ordinal lookup for stamping: the same walk enrichment uses, so the two sides
// can never drift.
export function evidenceOrdinals(sessionId: string): Map<string, number> {
  const ordinals = new Map<string, number>();
  buildEvidenceIndex(sessionId).forEach((entry, i) =>
    ordinals.set(entry.toolUseId, i + 1),
  );
  return ordinals;
}

// What the model emits via UpdateReport (§1a): evidence cited by tag, no tool
// ids, no data arrays. The server enriches this into the stored Report.
export interface ReportInput {
  status: ReportStatus;
  headline: string;
  rootCause: { summary: string; detail: string };
  hypotheses: Hypothesis[];
  evidence: { id: string; evidenceTag: string; summary: string }[];
  proposedFix: { summary: string; steps: string[]; evidenceIds: string[] };
}

const REPORT_STATUSES: ReportStatus[] = [
  "root_cause_identified",
  "inconclusive",
  "investigation_incomplete",
];
const HYPOTHESIS_STATES = ["root_cause", "disproven", "open"];
const CONFIDENCES = ["low", "medium", "high"];

// Defensive seatbelt behind the provider's schema enforcement; a corrupt call
// gets a corrective tool error instead of a corrupt stored report.
export function validateReportInput(
  input: Record<string, unknown>,
): ReportInput | null {
  const candidate = input as unknown as ReportInput;
  const stringArray = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((s) => typeof s === "string");
  if (!REPORT_STATUSES.includes(candidate.status)) return null;
  if (typeof candidate.headline !== "string") return null;
  if (
    typeof candidate.rootCause?.summary !== "string" ||
    typeof candidate.rootCause?.detail !== "string"
  ) {
    return null;
  }
  if (
    !Array.isArray(candidate.hypotheses) ||
    !candidate.hypotheses.every(
      (h) =>
        typeof h?.id === "string" &&
        typeof h.statement === "string" &&
        HYPOTHESIS_STATES.includes(h.state) &&
        CONFIDENCES.includes(h.confidence) &&
        typeof h.reason === "string" &&
        stringArray(h.evidenceIds),
    )
  ) {
    return null;
  }
  if (
    !Array.isArray(candidate.evidence) ||
    !candidate.evidence.every(
      (e) =>
        typeof e?.id === "string" &&
        typeof e.evidenceTag === "string" &&
        typeof e.summary === "string",
    )
  ) {
    return null;
  }
  if (
    typeof candidate.proposedFix?.summary !== "string" ||
    !stringArray(candidate.proposedFix?.steps) ||
    !stringArray(candidate.proposedFix?.evidenceIds)
  ) {
    return null;
  }
  return candidate;
}

function parseJson<T>(content: string): T | null {
  try {
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

// Prefer the series whose labels mention the alert target; a query can return
// several labelsets and the chart should show the one under investigation.
function pickSeries(
  series: PrometheusSeries[],
  alert: NormalizedAlert | null,
): PrometheusSeries {
  const first = series[0]!;
  if (alert === null || alert.targetIdentifier === null) return first;
  const tokens = serviceIdentityKey(alert.targetIdentifier)
    .split(/[^a-zA-Z0-9-]+/)
    .filter((t) => t.length > 2);
  if (tokens.length === 0) return first;
  return (
    series.find((s) => {
      const labels = JSON.stringify(s.metric);
      return tokens.some((t) => labels.includes(t));
    }) ?? first
  );
}

function seriesLabel(metric: Record<string, string>): string {
  const name = metric["__name__"] ?? "series";
  const qualifier =
    metric["container"] ?? metric["pod"] ?? metric["job"] ?? metric["instance"];
  return qualifier ? `${name} (${qualifier})` : name;
}

function downsample<T>(values: T[], max: number): T[] {
  if (values.length <= max) return values;
  const stride = (values.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => values[Math.round(i * stride)]!);
}

function chartSnapshotFrom(
  resultContent: string,
  alert: NormalizedAlert | null,
): ChartSnapshot | null {
  const parsed = parseJson<MetricsQueryResult>(resultContent);
  if (!parsed || !Array.isArray(parsed.series) || parsed.series.length === 0) {
    return null;
  }
  const series = pickSeries(parsed.series, alert);
  const points = downsample(series.values ?? [], MAX_CHART_POINTS)
    .filter((v) => Array.isArray(v) && v.length === 2)
    .map(
      ([sec, val]) =>
        [new Date(sec * 1000).toISOString(), Number(val)] as [string, number],
    );
  if (points.length === 0) return null;
  return { seriesLabel: seriesLabel(series.metric), points };
}

function changesSnapshotFrom(resultContent: string): ChangesSnapshot | null {
  const parsed = parseJson<GetRecentChangesResult>(resultContent);
  if (!parsed || !Array.isArray(parsed.pullRequests)) return null;
  return {
    pullRequests: parsed.pullRequests.map((pr) => ({
      number: pr.number,
      title: pr.title,
      author: pr.author,
      mergedAt: pr.mergedAt,
      url: pr.url,
    })),
  };
}

function snapshotsFor(
  entry: EvidenceIndexEntry,
  alert: NormalizedAlert | null,
): Partial<Pick<EvidenceItem, "chartSnapshot" | "changesSnapshot">> {
  if (entry.resultContent === null) return {};
  if (
    entry.toolName === "QueryMetrics" ||
    entry.toolName === "QueryMetricsRange"
  ) {
    const chartSnapshot = chartSnapshotFrom(entry.resultContent, alert);
    return chartSnapshot ? { chartSnapshot } : {};
  }
  if (entry.toolName === "GetRecentChanges") {
    const changesSnapshot = changesSnapshotFrom(entry.resultContent);
    return changesSnapshot ? { changesSnapshot } : {};
  }
  return {};
}

// Citations resolved and snapshots attached (§1c). An unknown tag drops the
// evidence entry and every reference to it - never a fabricated citation.
export function enrichReport(
  input: ReportInput,
  index: EvidenceIndexEntry[],
  alert: NormalizedAlert | null,
  model: string,
): Report {
  const byTag = new Map(index.map((entry) => [entry.tag, entry]));
  const evidence: EvidenceItem[] = [];
  const dropped = new Set<string>();
  for (const item of input.evidence) {
    const entry = byTag.get(item.evidenceTag);
    if (!entry) {
      dropped.add(item.id);
      continue;
    }
    evidence.push({
      id: item.id,
      toolUseId: entry.toolUseId,
      toolName: entry.toolName,
      summary: item.summary,
      ...snapshotsFor(entry, alert),
    });
  }
  const keep = (ids: string[]): string[] =>
    ids.filter((id) => !dropped.has(id));
  return {
    status: input.status,
    headline: input.headline,
    rootCause: input.rootCause,
    hypotheses: input.hypotheses.map((h) => ({
      ...h,
      evidenceIds: keep(h.evidenceIds),
    })),
    evidence,
    proposedFix: {
      ...input.proposedFix,
      evidenceIds: keep(input.proposedFix.evidenceIds),
    },
    updatedAt: new Date().toISOString(),
    model,
  };
}

// The single save path: persisting and announcing are one operation, so no
// caller can store a report the console never hears about.
export function saveReport(
  sessionId: string,
  report: Report,
  model: string,
): void {
  upsertReport(sessionId, report, model);
  publishReportUpdated(sessionId);
}

// The finish gate's last resort after the nudge cap: the run must still end
// with a complete report, so stamp the honest "couldn't conclude" terminal.
export function finalizeInconclusive(sessionId: string, model: string): void {
  const existing = getReport(sessionId);
  const report: Report = existing
    ? {
        ...existing,
        status: "inconclusive",
        updatedAt: new Date().toISOString(),
      }
    : {
        status: "inconclusive",
        headline: "",
        rootCause: { summary: "", detail: "" },
        hypotheses: [],
        evidence: [],
        proposedFix: { summary: "", steps: [], evidenceIds: [] },
        updatedAt: new Date().toISOString(),
        model,
      };
  saveReport(sessionId, report, model);
}
