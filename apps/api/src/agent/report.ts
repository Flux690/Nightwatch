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
import {
  amendRecord,
  appendHypothesis,
  getRecord,
} from "../session/record-store.js";
import { getTranscriptRows } from "../session/transcript-store.js";
import { publishReportUpdated } from "../session/stream.js";
import { targetKeyFromInput } from "../session/transcript.js";
import { evidenceKind, evidenceSource } from "./evidence-source.js";
import { highestEvidenceNumber } from "./evidence-id.js";

// What a recording tool tells the model. A refusal is a correction, not a fault:
// the act was rejected and the message says what to do instead.
export interface RecordOutcome {
  recorded: boolean;
  message: string;
}

interface ToolCall {
  toolUseId: string;
  // Absent on a tool no claim may rest on, which is never issued one.
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

// One walk of the durable transcript, which is the evidence trail. Handles are
// read off it rather than counted, so this walk cannot disagree with another.
async function toolCallsIn(sessionId: string): Promise<ToolCall[]> {
  const entries: ToolCall[] = [];
  const byToolUseId = new Map<string, ToolCall>();
  for (const message of await getTranscriptRows(sessionId)) {
    for (const part of message.parts) {
      if (part.type === "tool_call") {
        const entry: ToolCall = {
          toolUseId: part.id,
          ...(part.evidenceId !== undefined && {
            evidenceId: part.evidenceId,
          }),
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

/* Both halves matter: the provider's own id is never accepted, and a call still
   running shows nothing anyone can have read. */
async function knownCitations(
  sessionId: string,
  ids: string[],
): Promise<{ kept: string[]; pending: string[]; invented: string[] }> {
  const entries = await toolCallsIn(sessionId);
  const byEvidenceId = new Map(
    entries.flatMap((e) =>
      e.evidenceId === undefined ? [] : [[e.evidenceId, e] as const],
    ),
  );
  const kept: string[] = [];
  const pending: string[] = [];
  const invented: string[] = [];
  for (const id of new Set(ids)) {
    const trimmed = id.trim();
    const entry = byEvidenceId.get(trimmed);
    if (entry === undefined) invented.push(id);
    else if (entry.result === null) pending.push(id);
    // The key it resolved under, which is the form the record keeps.
    else kept.push(trimmed);
  }
  return { kept, pending, invented };
}

async function issuedRange(sessionId: string): Promise<string> {
  const highest = highestEvidenceNumber(await getTranscriptRows(sessionId));
  if (highest === 0) return "No call you have made can be cited yet.";
  return highest === 1
    ? "This investigation has e1."
    : `This investigation has e1 through e${highest}.`;
}

/* Both kinds in one message: waiting for a result and picking a different id are
   different corrections, and one claim can get both wrong at once. */
async function citationRefusal(
  sessionId: string,
  pending: string[],
  invented: string[],
): Promise<string> {
  const said = ["Not recorded."];
  if (pending.length > 0) {
    const one = pending.length === 1;
    said.push(
      `${pending.join(", ")} ${one ? "has" : "have"} not answered yet, so ${one ? "it shows" : "they show"} nothing you can have read. Every tool call in one message is made before any of them returns.`,
    );
  }
  if (invented.length > 0) {
    said.push(
      `${invented.join(", ")} ${invented.length === 1 ? "names" : "name"} no call you can cite. ${await issuedRange(sessionId)} A result that can back a claim opens with its own "evidenceId"; a tool that reads nothing about your system carries none.`,
    );
  }
  said.push("Record this again citing only calls you have already read.");
  return said.join(" ");
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

// Every cited call answered - a citation naming one that had not is refused when
// the claim is made. The outcome rides along: a cited miss and a cited crash differ.
export async function resolveEvidence(
  sessionId: string,
  record: InvestigationRecord,
): Promise<ResolvedEvidence[]> {
  const cited = citedIds(record);
  if (cited.size === 0) return [];
  const resolved: ResolvedEvidence[] = [];
  for (const entry of await toolCallsIn(sessionId)) {
    const { toolUseId, evidenceId, toolName, input, result, toolOutcome } =
      entry;
    if (evidenceId === undefined || !cited.has(evidenceId)) continue;
    if (result === null) continue;
    resolved.push({
      evidenceId,
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
export async function gatedCalls(sessionId: string): Promise<GatedCall[]> {
  return (await toolCallsIn(sessionId)).flatMap((entry) => {
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
export async function approvedWriteCount(sessionId: string): Promise<number> {
  return (await gatedCalls(sessionId)).filter((c) => c.decision === "approved")
    .length;
}

/* Compared against the record rather than a clock: the stamp is written by the
   same transaction as the report, so the two cannot disagree. */
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

/* Only a call a person released starts the clock that makes a later read a
   confirmation: a declined one changed nothing and a refused one never ran. */
function lastExecutedAt(calls: Map<string, ToolCall>): string | null {
  let latest: string | null = null;
  for (const entry of calls.values()) {
    if (entry.result === null || entry.humanDecision !== "approved") continue;
    if (latest === null || entry.timestamp > latest) latest = entry.timestamp;
  }
  return latest;
}

export async function computeConviction(
  sessionId: string,
  record: InvestigationRecord,
): Promise<ReportConviction> {
  // Keyed the way a claim cites, so a lookup needs no second vocabulary.
  const calls = new Map(
    (await toolCallsIn(sessionId)).flatMap((e) =>
      e.evidenceId === undefined ? [] : [[e.evidenceId, e] as const],
    ),
  );
  const executedAt = lastExecutedAt(calls);
  const graded: ReportConviction = {};
  for (const row of record.hypotheses) {
    const conviction = convictionOf(row.evidenceIds, calls, executedAt);
    if (conviction !== null) graded[row.id] = conviction;
  }
  return graded;
}

// A list rather than a boolean, so the record-gaps message can name only what
// is absent and a surviving gap can be logged as itself.
export type RecordGap =
  { kind: "empty_record" } | { kind: "unaccounted_calls"; calls: number };

/* The run's own count, because the record cannot say: a claim carries no mark of
   what it was recorded over. */
export async function recordGaps(
  sessionId: string,
  unaccounted: number,
): Promise<RecordGap[]> {
  const hypotheses = (await getRecord(sessionId))?.hypotheses ?? [];
  const gaps: RecordGap[] = [];

  if (hypotheses.length === 0) gaps.push({ kind: "empty_record" });
  // Only alongside a record that holds something: an empty one is already named
  // above, and saying both would ask twice for one thing.
  else if (unaccounted > 0)
    gaps.push({ kind: "unaccounted_calls", calls: unaccounted });

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
export async function recordHypothesis(
  sessionId: string,
  input: RecordHypothesisInput,
): Promise<RecordOutcome> {
  const { kept, pending, invented } = await knownCitations(
    sessionId,
    input.evidenceIds,
  );
  /* All of them or none: recording what survives changes the claim the model made
     and drops its conviction from corroborated to cited, silently. */
  if (pending.length > 0 || invented.length > 0 || kept.length === 0) {
    return {
      recorded: false,
      message: await citationRefusal(sessionId, pending, invented),
    };
  }
  const evidenceIds = kept;
  const { id, replaced } = await appendHypothesis(sessionId, (record) => {
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
  const replacement =
    replaced !== undefined
      ? ` It replaces ${replaced}, which stays on the record.`
      : input.supersedes !== undefined && input.supersedes !== ""
        ? ` ${input.supersedes} is not a claim on this record, so nothing was replaced.`
        : "";
  return {
    recorded: true,
    message: `Recorded ${id} as "${input.verdict}".${replacement}`,
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
export async function submitReport(
  sessionId: string,
  input: SubmitReportInput,
): Promise<RecordOutcome> {
  // Answered, not merely known: a timeline entry pointing at a call that never
  // returned shows the reader nothing when they open it.
  const resolve = async (id: string): Promise<string | undefined> =>
    (await knownCitations(sessionId, [id])).kept[0];
  // The entry is kept when its citation is dropped: the lane describes the
  // moment rather than the call, so an unresolvable id must not cost it.
  const timeline = await Promise.all(
    input.timeline.map(async (entry) => {
      const cited =
        entry.evidenceId === undefined
          ? undefined
          : await resolve(entry.evidenceId);
      return cited !== undefined
        ? { ...entry, evidenceId: cited }
        : {
            at: entry.at,
            what: entry.what,
            ...(entry.lane !== undefined && { lane: entry.lane }),
          };
    }),
  );
  const approvedWrites = await approvedWriteCount(sessionId);
  // Stamped inside the transaction, from the record being written against:
  // counted anywhere else it could name claims this report never saw.
  await amendRecord(sessionId, (record) => ({
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
