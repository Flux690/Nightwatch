// The only place the record is written, and the owner of its two rules: a
// citation is the id of the call that produced it, and nothing is unrecorded.

import type {
  Conviction,
  GatedCall,
  HumanDecision,
  Hypothesis,
  InvestigationRecord,
  ReportConviction,
  ResolvedEvidence,
  TimelineEntry,
  ToolOutcome,
  Verdict,
} from "@nightwarden/shared";
import { amendRecord, appendHypothesis, getRecord } from "../session/record.js";
import { getTranscriptRows } from "../session/transcript-store.js";
import { publishReportUpdated } from "../session/stream.js";
import { targetKeyFromInput } from "../session/transcript.js";
import { evidenceKind, evidenceSource } from "./evidence-source.js";
import { evidenceIdsByToolUseId } from "./evidence-id.js";

// What a recording tool tells the model. A refusal is a correction, not a fault:
// the act was rejected and the message says what to do instead.
export interface RecordOutcome {
  recorded: boolean;
  message: string;
}

interface ToolCall {
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

// One walk of the durable transcript, which is the evidence trail. The
// provider's own call id is the handle, so nothing here numbers or renames.
function toolCallsIn(sessionId: string): ToolCall[] {
  const rows = getTranscriptRows(sessionId);
  const evidenceIds = evidenceIdsByToolUseId(rows);
  const entries: ToolCall[] = [];
  const byToolUseId = new Map<string, ToolCall>();
  for (const message of rows) {
    for (const part of message.parts) {
      if (part.type === "tool_call") {
        const evidenceId = evidenceIds.get(part.id);
        const entry: ToolCall = {
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

// Existence, not completion: the model may cite a call from the same turn,
// whose result is persisted only once that turn ends.
function knownCitations(
  sessionId: string,
  ids: string[],
): { kept: string[]; invented: string[] } {
  const entries = toolCallsIn(sessionId);
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
  const total = toolCallsIn(sessionId).length;
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

// Everything the record points at, from either author: the hypotheses' own
// citations and the composed timeline's references.
function citedIds(record: InvestigationRecord): Set<string> {
  const timeline = record.report?.timeline ?? [];
  return new Set([
    ...record.hypotheses.flatMap((h) => h.evidenceIds),
    ...timeline.flatMap((entry) =>
      entry.evidenceId === undefined ? [] : [entry.evidenceId],
    ),
  ]);
}

// A citation whose call never answered resolves to nothing. The outcome rides
// along, because a cited miss and a cited crash differ.
export function resolveEvidence(
  sessionId: string,
  record: InvestigationRecord,
): ResolvedEvidence[] {
  const cited = citedIds(record);
  if (cited.size === 0) return [];
  const resolved: ResolvedEvidence[] = [];
  for (const entry of toolCallsIn(sessionId)) {
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

// Arithmetic over the trail and the action log, so no tool input can set it.
function convictionOf(
  ids: string[],
  calls: Map<string, ToolCall>,
  executedAt: string | null,
): Conviction | null {
  const entries = [...new Set(ids)]
    .flatMap((id) => calls.get(id) ?? [])
    .filter((entry) => entry.result !== null);
  if (entries.length === 0) return null;
  if (executedAt !== null && entries.some((e) => e.timestamp > executedAt)) {
    return "verified";
  }
  const sources = new Set(entries.map((e) => evidenceSource(e.toolName)));
  return sources.size >= 2 ? "corroborated" : "cited";
}

// A name cannot answer this: a refused call carries the name of a gated tool
// and reached no gate. An answered question is not a write.
export function gatedCalls(sessionId: string): GatedCall[] {
  return toolCallsIn(sessionId).flatMap((entry) => {
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

// Only the released ones: a declined write changed nothing, so it cannot put the
// write-up behind. Monotonic, since a call already answered never un-answers.
export function approvedWriteCount(sessionId: string): number {
  return gatedCalls(sessionId).filter((c) => c.decision === "approved").length;
}

/* Whether the write-up no longer covers the record. Compared against the record
   itself rather than a clock: the stamp is written by the same transaction as the
   report, so it cannot disagree with what the report was composed from. */
export function reportIsBehind(
  record: InvestigationRecord,
  approvedWrites: number,
): boolean {
  const report = record.report;
  if (report === null) return true;
  // Hypotheses are append-only, so the last id changing is the whole test.
  return (
    (record.hypotheses.at(-1)?.id ?? "") !== report.hypothesesCoveredUpTo ||
    approvedWrites !== report.writesCoveredUpTo
  );
}

/* The instant the last released write answered, which makes a later read a
   confirmation. Only a call a person released starts that clock: a declined one
   changed nothing and a refused one never ran. */
function lastExecutedAt(calls: Map<string, ToolCall>): string | null {
  let latest: string | null = null;
  for (const entry of calls.values()) {
    if (entry.result === null || entry.humanDecision !== "approved") continue;
    if (latest === null || entry.timestamp > latest) latest = entry.timestamp;
  }
  return latest;
}

export function computeConviction(
  sessionId: string,
  record: InvestigationRecord,
): ReportConviction {
  const calls = new Map(toolCallsIn(sessionId).map((e) => [e.toolUseId, e]));
  const executedAt = lastExecutedAt(calls);
  const graded: ReportConviction = {};
  for (const row of record.hypotheses) {
    const conviction = convictionOf(row.evidenceIds, calls, executedAt);
    if (conviction !== null) graded[row.id] = conviction;
  }
  return graded;
}

// Read by the status derivation and by the report gate, so what the list calls
// actionable and what the gate accepts cannot disagree.
export function isActionable(record: InvestigationRecord | null): boolean {
  if (record === null) return false;
  const recommended = (record.report?.recommendation ?? "").trim() !== "";
  return (
    recommended ||
    record.hypotheses.some(
      (h) => h.verdict === "root_cause" && h.evidenceIds.length > 0,
    )
  );
}

// A list rather than a boolean, so the record-gaps message can name only what
// is absent and a surviving gap can be logged as itself.
export type ReportGap =
  | { kind: "empty_record" }
  | { kind: "unresolvable_citation"; ids: string[] }
  | { kind: "unaccounted_calls"; calls: number };

/* `unaccounted` is the run's own count of evidence calls answered since its last
   claim: the record cannot say, because a claim carries no mark of what it was
   recorded over. */
export function reportGaps(
  sessionId: string,
  unaccounted: number,
): ReportGap[] {
  const record = getRecord(sessionId);
  const hypotheses = record?.hypotheses ?? [];
  const gaps: ReportGap[] = [];

  if (hypotheses.length === 0) gaps.push({ kind: "empty_record" });
  // Only alongside a record that holds something: an empty one is already named
  // above, and saying both would ask twice for one thing.
  else if (unaccounted > 0)
    gaps.push({ kind: "unaccounted_calls", calls: unaccounted });

  if (record !== undefined) {
    const resolved = new Set(
      resolveEvidence(sessionId, record).map((e) => e.toolUseId),
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
  supersedes?: string;
}

// A link to a claim that exists, or nothing. Dropped rather than refused: the
// new claim is worth recording even when what it replaces was named wrongly.
function supersededBy(
  record: InvestigationRecord,
  named: string | undefined,
): string | undefined {
  if (named === undefined || named === "") return undefined;
  return record.hypotheses.some((h) => h.id === named) ? named : undefined;
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
  const { id, replaced } = appendHypothesis(sessionId, (record) => {
    const supersedes = supersededBy(record, input.supersedes);
    const hypothesis: Hypothesis = {
      id: `h${record.hypotheses.length + 1}`,
      statement: input.statement,
      verdict: input.verdict,
      finding: input.finding,
      evidenceIds,
      ...(supersedes !== undefined && { supersedes }),
      recordedAt: new Date().toISOString(),
    };
    return {
      next: { ...record, hypotheses: [...record.hypotheses, hypothesis] },
      value: { id: hypothesis.id, replaced: supersedes },
    };
  });
  publishReportUpdated(sessionId);
  // Each clause is a separate correction, so a call that got two things wrong
  // is told about both rather than only the first.
  const dropped =
    invented.length === 0
      ? ""
      : ` ${invented.join(", ")} named no call you made and ${invented.length === 1 ? "was" : "were"} dropped.`;
  const replacement =
    replaced !== undefined
      ? ` It replaces ${replaced}, which stays on the record.`
      : input.supersedes !== undefined && input.supersedes !== ""
        ? ` ${input.supersedes} is not a claim on this record, so nothing was replaced.`
        : "";
  return {
    recorded: true,
    message: `Recorded ${id} as "${input.verdict}".${replacement}${dropped}`,
  };
}

interface SubmitReportInput {
  headline: string;
  affected: string;
  summary: string;
  timeline: TimelineEntry[];
  impact: string;
  recommendation: string;
}

// Written whole rather than appended, because it is authored once. Citations
// are filtered as a hypothesis's are, so no entry points at a call that never ran.
export function submitReport(
  sessionId: string,
  input: SubmitReportInput,
): RecordOutcome {
  const entries = toolCallsIn(sessionId);
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
  // The entry is kept when its citation is dropped: the lane describes the
  // moment rather than the call, so an unresolvable id must not cost it.
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
  const approvedWrites = approvedWriteCount(sessionId);
  // Stamped inside the transaction, from the record being written against: a
  // watermark taken anywhere else could name claims this report never saw.
  amendRecord(sessionId, (record) => ({
    ...record,
    report: {
      headline: input.headline,
      affected: input.affected,
      summary: input.summary,
      timeline,
      impact: input.impact,
      recommendation: input.recommendation,
      submittedAt: new Date().toISOString(),
      hypothesesCoveredUpTo: record.hypotheses.at(-1)?.id ?? "",
      writesCoveredUpTo: approvedWrites,
    },
  }));
  publishReportUpdated(sessionId);
  return { recorded: true, message: "Report recorded." };
}
