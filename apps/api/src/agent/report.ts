import type {
  Hypothesis,
  Report,
  ReportStatus,
  ResolvedEvidence,
} from "@nightwarden/shared";
import { getReport, upsertReport } from "../db/reports.js";
import { getSessionMessages } from "../db/sessions.js";
import { getToolOutcomes } from "../db/tool-outcomes.js";
import { publishReportUpdated } from "../session/stream.js";

// The report domain service: the ONLY place a report is saved, and the owner of
// the rule that a citation is the id of the tool call that produced it.

// What the model emits via UpdateReport: claims, each citing the tool calls that
// back it. Everything else the report shows is resolved from the transcript.
export interface ReportInput {
  status: ReportStatus;
  headline: string;
  rootCause: { summary: string; detail: string };
  hypotheses: Hypothesis[];
  recommendedFix: { summary: string; evidenceIds: string[] };
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
    typeof candidate.recommendedFix?.summary !== "string" ||
    !stringArray(candidate.recommendedFix?.evidenceIds)
  ) {
    return null;
  }
  return candidate;
}

interface ToolCall {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  result: string | null;
}

// One walk of the durable transcript, which is the only record of what ran. The
// provider's own call id is the citation handle, so nothing here numbers,
// renames or copies anything.
function toolCallsIn(sessionId: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const byToolUseId = new Map<string, ToolCall>();
  for (const message of getSessionMessages(sessionId)) {
    for (const part of message.parts) {
      if (part.type === "tool_call") {
        const call: ToolCall = {
          toolUseId: part.id,
          toolName: part.name,
          input: part.input,
          result: null,
        };
        calls.push(call);
        byToolUseId.set(part.id, call);
      } else if (part.type === "tool_result") {
        const call = byToolUseId.get(part.toolCallId);
        if (call) call.result = part.output;
      }
    }
  }
  return calls;
}

function citedIds(report: Report): Set<string> {
  return new Set([
    ...report.hypotheses.flatMap((h) => h.evidenceIds),
    ...report.recommendedFix.evidenceIds,
  ]);
}

// In the order the calls happened, which is the order they are worth reading.
// A citation whose call has not answered yet resolves to nothing: there is
// nothing to quote, and an invented id must stay unrenderable. The outcome
// rides along because a cited miss and a cited crash are not the same evidence.
export function resolveEvidence(
  sessionId: string,
  report: Report,
): ResolvedEvidence[] {
  const cited = citedIds(report);
  if (cited.size === 0) return [];
  const outcomes = getToolOutcomes(sessionId);
  const resolved: ResolvedEvidence[] = [];
  for (const { toolUseId, toolName, input, result } of toolCallsIn(sessionId)) {
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

// Citations kept only where they name a call this session actually made, so a
// fabricated one stays unrenderable. The claim itself always survives: an
// overreach must read as a missing citation, never as a missing sentence.
export function enrichReport(
  input: ReportInput,
  sessionId: string,
  model: string,
): Report {
  // Existence, not completion: the model may cite a call from the same turn,
  // whose result is persisted only once the turn ends.
  const known = new Set(toolCallsIn(sessionId).map((c) => c.toolUseId));
  const keep = (ids: string[]): string[] => ids.filter((id) => known.has(id));
  return {
    status: input.status,
    headline: input.headline,
    rootCause: input.rootCause,
    hypotheses: input.hypotheses.map((h) => ({
      ...h,
      evidenceIds: keep(h.evidenceIds),
    })),
    recommendedFix: {
      ...input.recommendedFix,
      evidenceIds: keep(input.recommendedFix.evidenceIds),
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
        recommendedFix: { summary: "", evidenceIds: [] },
        updatedAt: new Date().toISOString(),
        model,
      };
  saveReport(sessionId, report, model);
}
