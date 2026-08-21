import type {
  Conviction,
  EvidenceKind,
  GatedCall,
  HumanDecision,
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
import { publishReportUpdated } from "../session/stream.js";
import { targetKeyFromInput } from "../session/transcript.js";
import { findTool } from "./tools/toolset.js";
import { evidenceSource } from "./evidence-source.js";
import { evidenceIdsByToolUseId } from "./evidence-id.js";

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
  // e1, e2, e3 in call order. Derived by this walk rather than stored, so the
  // side that shows it to the model and the side that resolves it agree.
  evidenceId?: string;
  toolName: string;
  input: Record<string, unknown>;
  result: string | null;
  // Absent when the call simply answered. Carried on the result part it belongs
  // to, so one walk answers both what a call returned and how it went.
  toolOutcome?: ToolOutcome;
  // Absent unless a person was asked about this call, which is the only thing
  // that makes it a released write rather than a call the harness ran or refused.
  humanDecision?: HumanDecision;
  timestamp: string;
}

// One walk of the durable transcript, which is the ledger. The provider's own
// call id is the citation handle, so nothing here numbers or renames anything.
function ledgerIn(sessionId: string): LedgerEntry[] {
  const rows = getTranscriptRows(sessionId);
  const evidenceIds = evidenceIdsByToolUseId(rows);
  const entries: LedgerEntry[] = [];
  const byToolUseId = new Map<string, LedgerEntry>();
  for (const message of rows) {
    for (const part of message.parts) {
      if (part.type === "tool_call") {
        const evidenceId = evidenceIds.get(part.id);
        const entry: LedgerEntry = {
          toolUseId: part.id,
          ...(evidenceId !== undefined && { evidenceId }),
          toolName: part.name,
          input: part.input,
          result: null,
          timestamp: message.timestamp,
        };
        entries.push(entry);
        byToolUseId.set(part.id, entry);
      } else if (part.type === "tool_result") {
        const entry = byToolUseId.get(part.toolCallId);
        if (entry) {
          entry.result = part.output;
          if (part.toolOutcome !== undefined)
            entry.toolOutcome = part.toolOutcome;
          if (part.humanDecision !== undefined) {
            entry.humanDecision = part.humanDecision;
          }
        }
      }
    }
  }
  return entries;
}

// Citations kept only where they name a call this session made, so a fabricated
// one stays unrenderable. Existence, not completion: the model may cite a call
// from the same turn, whose result is persisted only once the turn ends.
function knownCitations(
  sessionId: string,
  ids: string[],
): { kept: string[]; invented: string[] } {
  const entries = ledgerIn(sessionId);
  const byEvidenceId = new Map(
    entries.flatMap((e) =>
      e.evidenceId === undefined ? [] : [[e.evidenceId, e.toolUseId] as const],
    ),
  );
  const known = new Set(entries.map((e) => e.toolUseId));
  const kept: string[] = [];
  const invented: string[] = [];
  for (const id of new Set(ids)) {
    // Cited as e3, or as the provider's own id by a model that found it.
    const resolved = byEvidenceId.get(id.trim()) ?? id;
    if (known.has(resolved)) kept.push(resolved);
    else invented.push(id);
  }
  return { kept, invented };
}

// What the model cited that names no call, said back in the vocabulary it was
// given, with the range it could have picked from.
function citationRefusal(sessionId: string, invented: string[]): string {
  const total = ledgerIn(sessionId).length;
  const available =
    total === 0
      ? "You have made no tool calls yet, so there is nothing to cite."
      : total === 1
        ? "This investigation has e1."
        : `This investigation has e1 through e${total}.`;
  return `Not recorded: ${invented.join(", ")} ${
    invented.length === 1 ? "names" : "name"
  } no call you made. ${available} Each tool result begins with its own id in brackets; copy one of those and record this again.`;
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

// What to draw a cited call as, from the tool's own declaration. A name the
// registry no longer knows - a tool renamed in an upgrade - reads as plain text,
// which is the honest fallback: the result is still quotable, just not typed.
function evidenceKind(toolName: string): EvidenceKind {
  return findTool(toolName)?.evidenceKind ?? "text";
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
  const resolved: ResolvedEvidence[] = [];
  for (const entry of ledgerIn(sessionId)) {
    const { toolUseId, toolName, input, result, toolOutcome } = entry;
    if (!cited.has(toolUseId) || result === null) continue;
    resolved.push({
      toolUseId,
      toolName,
      kind: evidenceKind(toolName),
      input,
      result,
      ...(toolOutcome !== undefined && { toolOutcome }),
      ...(entry.humanDecision !== undefined && {
        humanDecision: entry.humanDecision,
      }),
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

/* Every call a person was actually asked about, read from what was recorded at
   the call. A name cannot answer this: a refused call carries the name of a
   gated tool and reached no gate. An answered question is not a write. */
export function gatedCalls(sessionId: string): GatedCall[] {
  return ledgerIn(sessionId).flatMap((entry) => {
    const { humanDecision, toolOutcome } = entry;
    if (entry.result === null) return [];
    if (humanDecision !== "approved" && humanDecision !== "rejected") return [];
    return [
      {
        toolUseId: entry.toolUseId,
        toolName: entry.toolName,
        target: targetKeyFromInput(entry.input),
        at: entry.timestamp,
        decision: humanDecision,
        ...(toolOutcome !== undefined && { toolOutcome }),
        result: entry.result,
      },
    ];
  });
}

/* The instant the last released write answered, which makes a later read a
   confirmation. Only a call a person released starts that clock: a declined one
   changed nothing and a refused one never ran. */
function lastExecutedAt(ledger: Map<string, LedgerEntry>): string | null {
  let latest: string | null = null;
  for (const entry of ledger.values()) {
    if (entry.result === null || entry.humanDecision !== "approved") continue;
    if (latest === null || entry.timestamp > latest) latest = entry.timestamp;
  }
  return latest;
}

export function computeConviction(
  sessionId: string,
  report: Report,
): ReportConviction {
  const ledger = new Map(ledgerIn(sessionId).map((e) => [e.toolUseId, e]));
  const executedAt = lastExecutedAt(ledger);
  const graded: ReportConviction = {};
  for (const row of report.hypotheses) {
    const conviction = convictionOf(row.evidenceIds, ledger, executedAt);
    if (conviction !== null) graded[row.id] = conviction;
  }
  return graded;
}

// Read by the status derivation and by the report gate, so what the list calls
// actionable and what the gate accepts cannot disagree.
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
// write up. A list rather than a boolean so the completion request can name only
// what is absent, and so a gap that survives a request can be logged as itself.
export type ReportGap =
  { kind: "empty_record" } | { kind: "unresolvable_citation"; ids: string[] };

/* "I could not conclude, here is what I checked" is a complete record, and the
   gate must never push a model past it. Two kinds, not four: a hypothesis is
   recorded settled, and an uncited claim never reaches the record. */
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
  const { kept, invented } = knownCitations(sessionId, input.evidenceIds);
  /* Refused rather than recorded with what survives. The schema check ran before
     this filter and nothing looked again, so a claim citing two invented ids was
     stored citing nothing. */
  if (kept.length === 0) {
    return { recorded: false, message: citationRefusal(sessionId, invented) };
  }
  const evidenceIds = kept;
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
  return {
    recorded: true,
    message:
      invented.length === 0
        ? `Recorded ${id} as "${input.verdict}".`
        : `Recorded ${id} as "${input.verdict}", citing ${evidenceIds.length} of the ids you gave. ${invented.join(", ")} named no call you made and ${invented.length === 1 ? "was" : "were"} dropped.`,
  };
}

interface SubmitReportInput {
  headline?: string;
  affected?: string;
  summary: string;
  timeline: TimelineEntry[];
  impact: string;
  recommendation: string;
}

// The report turn's one write. Citations are filtered the same way a
// hypothesis's are, so a timeline entry cannot point at a call that never
// happened. Written whole rather than appended: it is authored once.
export function submitReport(
  sessionId: string,
  input: SubmitReportInput,
): RecordOutcome {
  const entries = ledgerIn(sessionId);
  const known = new Set(entries.map((e) => e.toolUseId));
  const byEvidenceId = new Map(
    entries.flatMap((e) =>
      e.evidenceId === undefined ? [] : [[e.evidenceId, e.toolUseId] as const],
    ),
  );
  const resolve = (id: string): string | undefined => {
    const toolUseId = byEvidenceId.get(id.trim()) ?? id;
    return known.has(toolUseId) ? toolUseId : undefined;
  };
  // A citation naming no call is dropped and the entry kept, exactly as a
  // hypothesis's is. The lane survives either way: it describes the moment, not
  // the call, so an unresolvable id must not cost the row its strand.
  const timeline = input.timeline.map((entry) => {
    const cited =
      entry.evidenceId === undefined ? undefined : resolve(entry.evidenceId);
    return cited !== undefined
      ? { ...entry, evidenceId: cited }
      : {
          at: entry.at,
          what: entry.what,
          ...(entry.lane !== undefined && { lane: entry.lane }),
        };
  });
  const submitted: SubmittedReport = {
    ...(input.headline !== undefined && { headline: input.headline }),
    ...(input.affected !== undefined && { affected: input.affected }),
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
