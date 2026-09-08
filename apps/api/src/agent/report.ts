// The only place the record is written, and the owner of its two rules: a
// citation is the id of the call that produced it, and nothing is unrecorded.

import type {
  EvidenceKind,
  GatedCall,
  Hypothesis,
  InvestigationRecord,
  ResolvedEvidence,
  TimelineEntry,
  TranscriptRow,
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
import { evidenceNumber } from "./evidence-id.js";
import { DOCKER_TOOLS } from "./tools/docker.js";
import { GITHUB_TOOLS } from "./tools/github.js";
import { HOST_TOOLS } from "./tools/host.js";
import { K8S_TOOLS } from "./tools/kubernetes.js";
import { LOKI_TOOLS } from "./tools/loki.js";
import { METRICS_TOOLS } from "./tools/metrics.js";
import { REPO_TOOLS } from "./tools/repo.js";
import { SENTRY_TOOLS } from "./tools/sentry.js";

/* Held apart from the registry, which reaches the record's own tools and would
   cycle back through here. Each entry is read off the tool, never listed. */
const RENDERER = new Map<string, EvidenceKind>(
  [
    DOCKER_TOOLS,
    HOST_TOOLS,
    K8S_TOOLS,
    REPO_TOOLS,
    GITHUB_TOOLS,
    METRICS_TOOLS,
    LOKI_TOOLS,
    SENTRY_TOOLS,
  ]
    .flat()
    .flatMap((tool) =>
      tool.citable ? [[tool.schema.name, tool.renderAs] as const] : [],
    ),
);

/* Recording a claim, writing the report and asking a person observe nothing, so
   none of them earns an evidence id and none can back a claim. */
export function isCitable(toolName: string): boolean {
  return RENDERER.has(toolName);
}

// A cited call whose tool this build no longer offers reads as plain text: its
// result is still quotable, just no longer typed.
function evidenceKind(toolName: string): EvidenceKind {
  return RENDERER.get(toolName) ?? "text";
}

// What a recording tool tells the model. A refusal is a correction, not a fault:
// the act was rejected and the message says what to do instead.
export interface RecordOutcome {
  recorded: boolean;
  message: string;
}

interface ToolCall {
  toolCallId: string;
  // Absent until the call answers, and absent for good on a tool no claim may
  // rest on: the handle rides the result rather than the request.
  evidenceId?: string;
  toolName: string;
  input: Record<string, unknown>;
  result: string | null;
  // Carried on the result part it belongs to, so one walk answers both what a
  // call returned and whether it failed.
  isError?: boolean;
  // Absent unless a person was asked about this call, which is the only thing
  // that makes it a released write rather than a call the harness ran or refused.
  approved?: boolean;
  timestamp: string;
}

// One walk of the durable transcript, which is the evidence trail. Handles are
// read off it rather than counted, so this walk cannot disagree with another.
function toolCallsFrom(messages: readonly TranscriptRow[]): ToolCall[] {
  const entries: ToolCall[] = [];
  const byToolCallId = new Map<string, ToolCall>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool_call") {
        const entry: ToolCall = {
          toolCallId: part.toolCallId,
          toolName: part.name,
          input: part.input,
          result: null,
          timestamp: message.timestamp,
        };
        entries.push(entry);
        byToolCallId.set(part.toolCallId, entry);
      } else if (part.type === "tool_result") {
        const entry = byToolCallId.get(part.toolCallId);
        if (entry) {
          entry.result = part.output;
          if (part.evidenceId !== undefined) entry.evidenceId = part.evidenceId;
          if (part.isError === true) entry.isError = true;
        }
      } else if (part.type === "tool_approval") {
        const entry = byToolCallId.get(part.toolCallId);
        if (entry) {
          entry.approved = part.approved;
        }
      }
    }
  }
  return entries;
}

// The one read a report request makes: every join below is a pure function over
// what it returns, so the same transcript is not fetched three times.
export async function toolCallsIn(sessionId: string): Promise<ToolCall[]> {
  return toolCallsFrom(await getTranscriptRows(sessionId));
}

/* One split, because a handle exists only once its result does: an id naming no
   answered call is unknown whether the model invented it or jumped ahead. */
function knownCitations(
  entries: readonly ToolCall[],
  ids: string[],
): { kept: string[]; unknown: string[] } {
  const issued = new Set(
    entries.flatMap((e) => (e.evidenceId === undefined ? [] : [e.evidenceId])),
  );
  const kept: string[] = [];
  const unknown: string[] = [];
  for (const id of new Set(ids)) {
    // The key it resolved under, which is the form the record keeps.
    const trimmed = id.trim();
    if (issued.has(trimmed)) kept.push(trimmed);
    else unknown.push(id);
  }
  return { kept, unknown };
}

function issuedRange(entries: readonly ToolCall[]): string {
  const highest = entries.reduce(
    (top, e) => Math.max(top, evidenceNumber(e.evidenceId)),
    0,
  );
  if (highest === 0) return "No call you have made can be cited yet.";
  return highest === 1
    ? "This investigation has e1."
    : `This investigation has e1 through e${highest}.`;
}

// One correction, because the model needs the same move either way: cite a
// result it has read.
function citationRefusal(
  entries: readonly ToolCall[],
  unknown: string[],
): string {
  const one = unknown.length === 1;
  return `Not recorded. ${unknown.join(", ")} ${one ? "names" : "name"} no result you have read. ${issuedRange(entries)} A handle arrives inside the result itself, so a tool you asked for in this same reply does not have one yet and its result reaches you in your next message. Record this again citing only results you have already read.`;
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
export function resolveEvidence(
  entries: readonly ToolCall[],
  record: InvestigationRecord,
): ResolvedEvidence[] {
  const cited = citedIds(record);
  if (cited.size === 0) return [];
  const resolved: ResolvedEvidence[] = [];
  for (const entry of entries) {
    const { toolCallId, evidenceId, toolName, input, result } = entry;
    if (evidenceId === undefined || !cited.has(evidenceId)) continue;
    if (result === null) continue;
    resolved.push({
      evidenceId,
      toolCallId,
      toolName,
      kind: evidenceKind(toolName),
      input,
      result,
      ...(entry.approved !== undefined && { approved: entry.approved }),
    });
  }
  return resolved;
}

// A name cannot answer this: a refused call carries the name of a gated tool
// and reached no gate. An answered question is not a write.
export function gatedCalls(entries: readonly ToolCall[]): GatedCall[] {
  return entries.flatMap((entry) => {
    const { approved, isError } = entry;
    if (entry.result === null || approved === undefined) return [];
    return [
      {
        toolCallId: entry.toolCallId,
        toolName: entry.toolName,
        target: targetKeyFromInput(entry.input),
        at: entry.timestamp,
        decision: approved ? "approved" : "rejected",
        ...(isError === true && { isError: true }),
        result: entry.result,
      },
    ];
  });
}

// Only the released ones: a declined write changed nothing, so it cannot put the
// write-up behind. Monotonic, since a call already answered never un-answers.
export function approvedWriteCount(calls: readonly GatedCall[]): number {
  return calls.filter((c) => c.decision === "approved").length;
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
  const entries = await toolCallsIn(sessionId);
  const { kept, unknown } = knownCitations(entries, input.evidenceIds);
  /* All of them or none: recording what survives changes the claim the model
     made, on a record that says nothing about what it dropped. */
  if (unknown.length > 0 || kept.length === 0) {
    return {
      recorded: false,
      message: citationRefusal(entries, unknown),
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
  const entries = await toolCallsIn(sessionId);
  const resolve = (id: string): string | undefined =>
    knownCitations(entries, [id]).kept[0];
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
  const approvedWrites = approvedWriteCount(gatedCalls(entries));
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
