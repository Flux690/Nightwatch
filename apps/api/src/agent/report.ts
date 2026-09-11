// The only place the record is written, and the owner of its rules: a citation
// is the id of the call that produced it, and nothing is unrecorded.

import type {
  Candidate,
  EvidenceKind,
  Finding,
  GatedCall,
  InvestigationRecord,
  ResolvedEvidence,
  TimelineEntry,
  TranscriptRow,
  Verdict,
} from "@nightwarden/shared";
import { supersededIds } from "@nightwarden/shared";
import {
  amendRecord,
  getRecord,
  updateRecord,
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

/* Opening a candidate, recording a finding, writing the report and asking a
   person observe nothing, so none earns an evidence id and none can back a claim. */
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

// Everything the record points at, from either author: the findings' own
// citations and the composed timeline's references.
function citedIds(record: InvestigationRecord): Set<string> {
  const timeline = record.report?.timeline ?? [];
  return new Set([
    ...record.findings.flatMap((f) => f.evidenceIds),
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
  // Findings are append-only, so the last id changing is the whole test.
  return (
    (record.findings.at(-1)?.id ?? "") !== report.findingsCoveredUpTo ||
    approvedWrites !== report.writesCoveredUpTo
  );
}

// The candidates no non-superseded finding settles. A finding that once settled
// one but was itself replaced reopens it, so the set is read live off the record.
export function openCandidateIds(record: InvestigationRecord): string[] {
  const replaced = supersededIds(record.findings);
  const settled = new Set(
    record.findings.flatMap((f) =>
      f.settles !== undefined && !replaced.has(f.id) ? [f.settles] : [],
    ),
  );
  return record.candidates.filter((c) => !settled.has(c.id)).map((c) => c.id);
}

// A list rather than a boolean, so the record-gaps message can name only what
// is absent and a surviving gap can be logged as itself.
export type RecordGap =
  | { kind: "empty_record" }
  | { kind: "untested_candidates"; candidates: number };

/* Read off the record: an empty one is named alone, and an open candidate is a
   test the run owes before it can finish. */
export async function recordGaps(sessionId: string): Promise<RecordGap[]> {
  const record = await getRecord(sessionId);
  const findings = record?.findings ?? [];
  if (findings.length === 0) return [{ kind: "empty_record" }];
  const open = record === undefined ? 0 : openCandidateIds(record).length;
  return open > 0 ? [{ kind: "untested_candidates", candidates: open }] : [];
}

interface OpenCandidatesInput {
  candidates: Array<{
    statement: string;
    ifTrue: string;
    ifFalse: string;
    parent?: string;
  }>;
}

// Assigns each id and appends. A parent must name a candidate that already
// exists or one opened earlier in this same call, or it is dropped.
export async function openCandidates(
  sessionId: string,
  input: OpenCandidatesInput,
): Promise<RecordOutcome> {
  const opened = await updateRecord(sessionId, (record) => {
    const known = new Set(record.candidates.map((c) => c.id));
    let n = record.candidates.length;
    const added: Candidate[] = input.candidates.map((c) => {
      const id = `c${++n}`;
      known.add(id);
      const parent =
        c.parent !== undefined && known.has(c.parent) ? c.parent : undefined;
      return {
        id,
        statement: c.statement,
        ifTrue: c.ifTrue,
        ifFalse: c.ifFalse,
        ...(parent !== undefined && { parent }),
      };
    });
    return {
      next: { ...record, candidates: [...record.candidates, ...added] },
      value: added,
    };
  });
  publishReportUpdated(sessionId);
  return {
    recorded: true,
    message:
      opened.length === 0
        ? "No candidates opened."
        : `Opened ${opened.map((c) => c.id).join(", ")}.`,
  };
}

// The candidate ids named in the last frontier message, so a resumed run reads
// what it already stated rather than restating it.
export async function setLastStatedCandidates(
  sessionId: string,
  ids: string[],
): Promise<void> {
  await amendRecord(sessionId, (record) => ({
    ...record,
    lastStatedCandidates: ids,
  }));
}

interface RecordFindingInput {
  statement: string;
  verdict: Verdict;
  explanation: string;
  evidenceIds: string[];
  settles?: string;
  supersedes?: string;
}

// A link to a record entry that exists, or nothing. Dropped rather than refused:
// the new finding is worth recording even when what it names was named wrongly.
function existing(
  ids: Set<string>,
  named: string | undefined,
): string | undefined {
  if (named === undefined || named === "") return undefined;
  return ids.has(named) ? named : undefined;
}

// One act, recorded once it has been tested. Append-only: a finding the model
// later disagrees with stays on the record beside the one that replaced it.
export async function recordFinding(
  sessionId: string,
  input: RecordFindingInput,
): Promise<RecordOutcome> {
  const entries = await toolCallsIn(sessionId);
  const { kept, unknown } = knownCitations(entries, input.evidenceIds);
  /* All of them or none: recording what survives changes the claim the model
     made, on a record that says nothing about what it dropped. */
  if (unknown.length > 0 || kept.length === 0) {
    return { recorded: false, message: citationRefusal(entries, unknown) };
  }
  const evidenceIds = kept;
  const { id, replaced, settled } = await updateRecord(sessionId, (record) => {
    const supersedes = existing(
      new Set(record.findings.map((f) => f.id)),
      input.supersedes,
    );
    const settles = existing(
      new Set(record.candidates.map((c) => c.id)),
      input.settles,
    );
    const finding: Finding = {
      id: `f${record.findings.length + 1}`,
      statement: input.statement,
      verdict: input.verdict,
      ...(settles !== undefined && { settles }),
      ...(supersedes !== undefined && { supersedes }),
      explanation: input.explanation,
      evidenceIds,
      recordedAt: new Date().toISOString(),
    };
    return {
      next: { ...record, findings: [...record.findings, finding] },
      value: { id: finding.id, replaced: supersedes, settled: settles },
    };
  });
  publishReportUpdated(sessionId);
  const replacement =
    replaced !== undefined
      ? ` It replaces ${replaced}, which stays on the record.`
      : input.supersedes !== undefined && input.supersedes !== ""
        ? ` ${input.supersedes} is not a finding on this record, so nothing was replaced.`
        : "";
  const settlement = settled !== undefined ? ` It settles ${settled}.` : "";
  return {
    recorded: true,
    message: `Recorded ${id} as "${input.verdict}".${settlement}${replacement}`,
  };
}

interface ComposeReportInput {
  headline: string;
  affected: string;
  summary: string;
  timeline: TimelineEntry[];
  impact: string;
  recommendation: string;
}

// Written whole rather than appended, because it is authored once. Citations
// are filtered as a finding's are, so no entry points at a call that never ran.
export async function composeReport(
  sessionId: string,
  input: ComposeReportInput,
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
  // counted anywhere else it could name findings this report never saw.
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
      findingsCoveredUpTo: record.findings.at(-1)?.id ?? "",
      writesCoveredUpTo: approvedWrites,
    },
  }));
  publishReportUpdated(sessionId);
  return { recorded: true, message: "Report recorded." };
}
