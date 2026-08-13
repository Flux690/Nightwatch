import type {
  Conviction,
  GatedCall,
  Hypothesis,
  Report,
  ReportConviction,
  ResolvedEvidence,
  SubmittedReport,
  TimelineEntry,
  ToolOutcome,
  Verdict,
} from "@nightwarden/shared";
import { amendReport, appendToReport, getReport } from "../db/reports.js";
import { getTranscriptRows } from "../db/sessions.js";
import { getToolOutcomes } from "../db/tool-outcomes.js";
import { publishReportUpdated } from "../session/stream.js";
import { targetKeyFromInput, wasGated } from "../session/transcript.js";
import { evidenceSource } from "./evidence-source.js";

// The report domain service: the only place the record is written, and the owner
// of the two rules that keep it honest - a citation is the id of the tool call
// that produced it, and nothing recorded can be unrecorded.

// What a recording tool tells the model. A refusal is a correction, not a fault:
// the act was rejected and the message says what to do instead.
export interface RecordOutcome {
  recorded: boolean;
  message: string;
}

interface LedgerEntry {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  result: string | null;
  timestamp: string;
}

// One walk of the durable transcript, which is the ledger. The provider's own
// call id is the citation handle, so nothing here numbers or renames anything.
function ledgerIn(sessionId: string): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  const byToolUseId = new Map<string, LedgerEntry>();
  for (const message of getTranscriptRows(sessionId)) {
    for (const part of message.parts) {
      if (part.type === "tool_call") {
        const entry: LedgerEntry = {
          toolUseId: part.id,
          toolName: part.name,
          input: part.input,
          result: null,
          timestamp: message.timestamp,
        };
        entries.push(entry);
        byToolUseId.set(part.id, entry);
      } else if (part.type === "tool_result") {
        const entry = byToolUseId.get(part.toolCallId);
        if (entry) entry.result = part.output;
      }
    }
  }
  return entries;
}

// Citations kept only where they name a call this session made, so a fabricated
// one stays unrenderable. Existence, not completion: the model may cite a call
// from the same turn, whose result is persisted only once the turn ends.
function knownCitations(sessionId: string, ids: string[]): string[] {
  const known = new Set(ledgerIn(sessionId).map((e) => e.toolUseId));
  return [...new Set(ids)].filter((id) => known.has(id));
}

// Everything the record points at, from either author: the ledger's claims and
// the composed timeline's references.
function citedIds(report: Report): Set<string> {
  const timeline = report.submitted?.timeline ?? [];
  return new Set([
    ...report.hypotheses.flatMap((h) => h.evidenceIds),
    ...timeline.flatMap((entry) =>
      entry.evidenceId === undefined ? [] : [entry.evidenceId],
    ),
  ]);
}

// In the order the calls happened, which is the order they are worth reading. A
// citation whose call has not answered resolves to nothing: there is nothing to
// quote. The outcome rides along - a cited miss and a cited crash differ.
export function resolveEvidence(
  sessionId: string,
  report: Report,
): ResolvedEvidence[] {
  const cited = citedIds(report);
  if (cited.size === 0) return [];
  const outcomes = getToolOutcomes(sessionId);
  const resolved: ResolvedEvidence[] = [];
  for (const { toolUseId, toolName, input, result } of ledgerIn(sessionId)) {
    if (!cited.has(toolUseId) || result === null) continue;
    const outcome = outcomes.get(toolUseId);
    resolved.push({
      toolUseId,
      toolName,
      input,
      result,
      ...(outcome !== undefined && { outcome }),
    });
  }
  return resolved;
}

// Arithmetic over the ledger and the action log, so no tool input can set it.
function convictionOf(
  ids: string[],
  ledger: Map<string, LedgerEntry>,
  executedAt: string | null,
): Conviction | null {
  const entries = [...new Set(ids)]
    .flatMap((id) => ledger.get(id) ?? [])
    .filter((entry) => entry.result !== null);
  if (entries.length === 0) return null;
  if (executedAt !== null && entries.some((e) => e.timestamp > executedAt)) {
    return "verified";
  }
  const sources = new Set(entries.map((e) => evidenceSource(e.toolName)));
  return sources.size >= 2 ? "corroborated" : "cited";
}

/* Every call the user had to release, and which way they went, read back
   from the session's own ledger. The registry says a call was gated, the outcome
   says it was declined, and who decided is not recorded: there is one user. */
export function gatedCalls(sessionId: string): GatedCall[] {
  const outcomes = getToolOutcomes(sessionId);
  return ledgerIn(sessionId).flatMap((entry) => {
    if (!wasGated(entry.toolName) || entry.result === null) return [];
    const outcome = outcomes.get(entry.toolUseId);
    return [
      {
        toolUseId: entry.toolUseId,
        toolName: entry.toolName,
        target: targetKeyFromInput(entry.input),
        at: entry.timestamp,
        decision:
          outcome === "rejected"
            ? ("rejected" as const)
            : ("approved" as const),
        ...(outcome !== undefined && { outcome }),
        result: entry.result,
      },
    ];
  });
}

// The instant the last released write answered, which is what makes a later read
// a confirmation rather than another observation. A declined call changed
// nothing, so it never starts that clock.
function lastExecutedAt(
  ledger: Map<string, LedgerEntry>,
  outcomes: Map<string, ToolOutcome>,
): string | null {
  let latest: string | null = null;
  for (const entry of ledger.values()) {
    if (entry.result === null || !wasGated(entry.toolName)) continue;
    if (outcomes.get(entry.toolUseId) === "rejected") continue;
    if (latest === null || entry.timestamp > latest) latest = entry.timestamp;
  }
  return latest;
}

export function computeConviction(
  sessionId: string,
  report: Report,
): ReportConviction {
  const ledger = new Map(ledgerIn(sessionId).map((e) => [e.toolUseId, e]));
  const executedAt = lastExecutedAt(ledger, getToolOutcomes(sessionId));
  const graded: ReportConviction = {};
  for (const row of report.hypotheses) {
    const conviction = convictionOf(row.evidenceIds, ledger, executedAt);
    if (conviction !== null) graded[row.id] = conviction;
  }
  return graded;
}

// Something for the user to act on: a written recommendation, or a cited
// root cause that amounts to one. Read by the status derivation and by the
// composition gate, so what the list calls actionable and what the gate accepts
// cannot disagree.
export function isActionable(report: Report | null): boolean {
  if (report === null) return false;
  const recommended = (report.submitted?.recommendation ?? "").trim() !== "";
  return (
    recommended ||
    report.hypotheses.some(
      (h) => h.verdict === "root_cause" && h.evidenceIds.length > 0,
    )
  );
}

// One named thing missing from the ledger, checked before the run is allowed to
// compose. A list rather than a boolean so the completion request can name only
// what is absent, and so a gap that survives a request can be logged as itself.
export type ReportGap =
  { kind: "empty_record" } | { kind: "unresolvable_citation"; ids: string[] };

/* A run that recorded what it tested has finished, whether or not any of it
   turned out to be the cause: "I could not conclude, here is what I checked" is
   a complete record, and the gate must never push a model past it.

   Two kinds, not four. A hypothesis is recorded settled, so none can be left
   open; and RecordHypothesis refuses a claim citing nothing, so an uncited root
   cause cannot reach the record to be caught here. */
export function reportGaps(sessionId: string): ReportGap[] {
  const report = getReport(sessionId);
  const hypotheses = report?.hypotheses ?? [];
  const gaps: ReportGap[] = [];

  if (hypotheses.length === 0) gaps.push({ kind: "empty_record" });

  if (report !== undefined) {
    const resolved = new Set(
      resolveEvidence(sessionId, report).map((e) => e.toolUseId),
    );
    const unbacked = hypotheses
      .filter(
        (row) =>
          row.evidenceIds.length > 0 &&
          !row.evidenceIds.some((id) => resolved.has(id)),
      )
      .map((row) => row.id);
    if (unbacked.length > 0)
      gaps.push({ kind: "unresolvable_citation", ids: unbacked });
  }

  return gaps;
}

interface RecordHypothesisInput {
  statement: string;
  verdict: Verdict;
  finding: string;
  evidenceIds: string[];
}

// One act, recorded once it has been tested. Append-only: a claim the model
// later disagrees with stays on the record beside the one that replaced it.
export function recordHypothesis(
  sessionId: string,
  input: RecordHypothesisInput,
): RecordOutcome {
  const evidenceIds = knownCitations(sessionId, input.evidenceIds);
  const id = appendToReport(sessionId, (report) => {
    const hypothesis: Hypothesis = {
      id: `h${report.hypotheses.length + 1}`,
      statement: input.statement,
      verdict: input.verdict,
      finding: input.finding,
      evidenceIds,
      recordedAt: new Date().toISOString(),
    };
    return {
      next: { ...report, hypotheses: [...report.hypotheses, hypothesis] },
      value: hypothesis.id,
    };
  });
  publishReportUpdated(sessionId);
  const dropped = new Set(input.evidenceIds).size - evidenceIds.length;
  return {
    recorded: true,
    message:
      dropped === 0
        ? `Recorded ${id} as "${input.verdict}".`
        : `Recorded ${id} as "${input.verdict}". ${dropped} of the ids you cited name no call you made and were dropped; cite the ids exactly as they appear on your own tool calls.`,
  };
}

interface SubmitReportInput {
  summary: string;
  timeline: TimelineEntry[];
  impact: string;
  recommendation: string;
}

// The composition turn's one write. Citations are filtered the same way a
// hypothesis's are, so a timeline entry cannot point at a call that never
// happened. Written whole rather than appended: it is authored once.
export function submitReport(
  sessionId: string,
  input: SubmitReportInput,
): RecordOutcome {
  const known = new Set(ledgerIn(sessionId).map((e) => e.toolUseId));
  const timeline = input.timeline.map((entry) =>
    entry.evidenceId !== undefined && known.has(entry.evidenceId)
      ? entry
      : { at: entry.at, what: entry.what },
  );
  const submitted: SubmittedReport = {
    summary: input.summary,
    timeline,
    impact: input.impact,
    recommendation: input.recommendation,
    submittedAt: new Date().toISOString(),
  };
  amendReport(sessionId, (report) => ({ ...report, submitted }));
  publishReportUpdated(sessionId);
  return { recorded: true, message: "Report recorded." };
}
