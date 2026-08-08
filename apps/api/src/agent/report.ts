import type {
  Conviction,
  GatedCall,
  Hypothesis,
  ProposedFix,
  Report,
  ReportConviction,
  ResolvedEvidence,
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
  createdAt: string;
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
          createdAt: message.createdAt,
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

function citedIds(report: Report): Set<string> {
  return new Set([
    ...report.hypotheses.flatMap((h) => h.evidenceIds),
    ...report.fixes.flatMap((f) => f.evidenceIds),
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
  if (executedAt !== null && entries.some((e) => e.createdAt > executedAt)) {
    return "verified";
  }
  const sources = new Set(entries.map((e) => evidenceSource(e.toolName)));
  return sources.size >= 2 ? "corroborated" : "cited";
}

/* Every call the operator had to release, and which way they went, read back
   from the session's own ledger. The registry says a call was gated, the outcome
   says it was declined, and who decided is not recorded: there is one operator. */
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
    if (latest === null || entry.createdAt > latest) latest = entry.createdAt;
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
  for (const row of [...report.hypotheses, ...report.fixes]) {
    const conviction = convictionOf(row.evidenceIds, ledger, executedAt);
    if (conviction !== null) graded[row.id] = conviction;
  }
  return graded;
}

// One named thing missing from the record. A list rather than a boolean so the
// completion request can name only what is absent, and so a gap that survives a
// request can be logged as itself.
export type ReportGap =
  | { kind: "empty_record" }
  | { kind: "open_hypothesis"; ids: string[] }
  | { kind: "uncited_root_cause"; ids: string[] }
  | { kind: "unresolvable_citation"; ids: string[] };

// A run that settled every hypothesis it proposed has finished, whether or not
// any of them turned out to be the cause: "I could not conclude, here is what I
// checked" is a complete record, and the gate must never push a model past it.
export function reportGaps(sessionId: string): ReportGap[] {
  const report = getReport(sessionId);
  const hypotheses = report?.hypotheses ?? [];
  const fixes = report?.fixes ?? [];
  const gaps: ReportGap[] = [];

  if (hypotheses.length === 0) gaps.push({ kind: "empty_record" });

  const open = hypotheses.filter((h) => h.verdict === "open").map((h) => h.id);
  if (open.length > 0) gaps.push({ kind: "open_hypothesis", ids: open });

  const uncited = hypotheses
    .filter((h) => h.verdict === "root_cause" && h.evidenceIds.length === 0)
    .map((h) => h.id);
  if (uncited.length > 0)
    gaps.push({ kind: "uncited_root_cause", ids: uncited });

  if (report !== undefined) {
    const resolved = new Set(
      resolveEvidence(sessionId, report).map((e) => e.toolUseId),
    );
    const unbacked = [...hypotheses, ...fixes]
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

export function proposeHypothesis(
  sessionId: string,
  statement: string,
): RecordOutcome {
  const id = appendToReport(sessionId, (report) => {
    const hypothesis: Hypothesis = {
      id: `h${report.hypotheses.length + 1}`,
      statement,
      verdict: "open",
      finding: "",
      evidenceIds: [],
      proposedAt: new Date().toISOString(),
      resolvedAt: null,
    };
    return {
      next: { ...report, hypotheses: [...report.hypotheses, hypothesis] },
      value: hypothesis.id,
    };
  });
  publishReportUpdated(sessionId);
  return {
    recorded: true,
    message: `Recorded as ${id}. Pass that id to ResolveHypothesis once you have tested it.`,
  };
}

export interface ResolveHypothesisInput {
  id: string;
  verdict: Verdict;
  finding: string;
  evidenceIds: string[];
}

export function resolveHypothesis(
  sessionId: string,
  input: ResolveHypothesisInput,
): RecordOutcome {
  const evidenceIds = knownCitations(sessionId, input.evidenceIds);
  const wrote = amendReport(sessionId, (report) => {
    const target = report.hypotheses.find((h) => h.id === input.id);
    if (target === undefined || target.verdict !== "open") return null;
    return {
      ...report,
      hypotheses: report.hypotheses.map((h) =>
        h.id === input.id
          ? {
              ...h,
              verdict: input.verdict,
              finding: input.finding,
              evidenceIds,
              resolvedAt: new Date().toISOString(),
            }
          : h,
      ),
    };
  });
  if (!wrote) {
    const existing = getReport(sessionId)?.hypotheses.find(
      (h) => h.id === input.id,
    );
    return {
      recorded: false,
      message:
        existing === undefined
          ? `There is no hypothesis ${input.id} in this investigation. Propose it first.`
          : `Hypothesis ${input.id} is already resolved as "${existing.verdict}" and the record cannot be rewritten. Propose a new hypothesis if your understanding has changed.`,
    };
  }
  const dropped = input.evidenceIds.length - evidenceIds.length;
  publishReportUpdated(sessionId);
  return {
    recorded: true,
    message:
      dropped === 0
        ? `Recorded ${input.id} as "${input.verdict}".`
        : `Recorded ${input.id} as "${input.verdict}". ${dropped} of the ids you cited name no call you made and were dropped; cite the ids exactly as they appear on your own tool calls.`,
  };
}

// Appended, never replaced: a fix the operator rejected stays on the record
// beside the one that superseded it.
export function proposeFix(
  sessionId: string,
  summary: string,
  citations: string[],
): RecordOutcome {
  const evidenceIds = knownCitations(sessionId, citations);
  const superseded = appendToReport(sessionId, (report) => {
    const fix: ProposedFix = {
      id: `f${report.fixes.length + 1}`,
      summary,
      evidenceIds,
      recordedAt: new Date().toISOString(),
    };
    return {
      next: { ...report, fixes: [...report.fixes, fix] },
      value: report.fixes.length > 0,
    };
  });
  publishReportUpdated(sessionId);
  return {
    recorded: true,
    message: superseded
      ? "Proposed fix recorded. It supersedes the one before it, which stays on the record."
      : "Proposed fix recorded.",
  };
}
