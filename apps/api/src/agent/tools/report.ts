import type { TimelineEntry, Verdict } from "@nightwarden/shared";
import {
  RECORD_HYPOTHESIS_SCHEMA,
  SUBMIT_INVESTIGATION_REPORT_SCHEMA,
} from "../prompts/report.js";
import {
  recordHypothesis,
  submitReport,
  type RecordOutcome,
} from "../report.js";
import type { Tool, ToolExecuteResult } from "./types.js";

// Thin adapters over the report domain service. RecordHypothesis is offered only
// to a session under investigation; SubmitInvestigationReport only on the
// composition turn, which is the loop's business rather than the toolset's.

const VERDICTS: Verdict[] = [
  "root_cause",
  "trigger",
  "symptom",
  "contributing_factor",
  "disproven",
];
function isVerdict(value: unknown): value is Verdict {
  return VERDICTS.some((v) => v === value);
}

// Prose the record cannot do without. A blank one is the model skipping the
// field, which stores a row nobody can read.
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function citations(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((id) => typeof id === "string") ? value : null;
}

// An empty string is how a required field says "none", so a timeline entry
// without a call carries no evidenceId rather than an empty one.
function timelineEntries(value: unknown): TimelineEntry[] | null {
  if (!Array.isArray(value)) return null;
  const entries: TimelineEntry[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) return null;
    const row = raw as Record<string, unknown>;
    const at = text(row["at"]);
    const what = text(row["what"]);
    if (at === null || what === null) return null;
    const evidenceId = text(row["evidenceId"]);
    entries.push({ at, what, ...(evidenceId !== null && { evidenceId }) });
  }
  return entries;
}

// Defensive seatbelt behind the provider's schema enforcement; a corrupt call
// gets a corrective tool error instead of a corrupt stored record.
function malformed(message: string): ToolExecuteResult {
  return { content: message, outcome: "system" };
}

// A refusal is the record holding its ground, not a fault: the tool worked and
// what was asked for is not available.
function toResult(outcome: RecordOutcome): ToolExecuteResult {
  return outcome.recorded
    ? { content: outcome.message }
    : { content: outcome.message, outcome: "expected_miss" };
}

export const REPORT_TOOLS: Tool[] = [
  {
    schema: RECORD_HYPOTHESIS_SCHEMA,
    access: "read",
    on: "api",
    execute: async (input, ctx): Promise<ToolExecuteResult> => {
      const statement = text(input["statement"]);
      const finding = input["finding"];
      const verdict = input["verdict"];
      const evidenceIds = citations(input["evidenceIds"]);
      if (
        statement === null ||
        typeof finding !== "string" ||
        !isVerdict(verdict)
      ) {
        return malformed(
          `Recording a hypothesis needs a statement, a finding, and one of these verdicts: ${VERDICTS.join(", ")}.`,
        );
      }
      if (evidenceIds === null || evidenceIds.length === 0) {
        return malformed(
          "A verdict needs at least one citation. Pass the ids of the tool calls whose results settled this hypothesis.",
        );
      }
      return toResult(
        recordHypothesis(ctx.sessionId, {
          statement,
          verdict,
          finding,
          evidenceIds,
        }),
      );
    },
  },
];

/* Never in the toolset: the loop attaches this one schema, alone, on the
   composition turn. Offering it alongside the investigation tools would let a
   run write itself up in the middle of working. */
export const SUBMIT_REPORT_TOOL: Tool = {
  schema: SUBMIT_INVESTIGATION_REPORT_SCHEMA,
  access: "read",
  on: "api",
  execute: async (input, ctx): Promise<ToolExecuteResult> => {
    const summary = text(input["summary"]);
    const impact = text(input["impact"]);
    const recommendation = text(input["recommendation"]);
    const timeline = timelineEntries(input["timeline"]);
    if (summary === null || timeline === null) {
      return malformed(
        "A report needs a summary and a timeline array, which may be empty.",
      );
    }
    return toResult(
      submitReport(ctx.sessionId, {
        summary,
        timeline,
        impact: impact ?? "",
        recommendation: recommendation ?? "",
      }),
    );
  },
};
