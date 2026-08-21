import { z } from "zod";
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
// report turn, which is the loop's business rather than the toolset's.

// Prose the record cannot do without. A blank one is the model skipping the
// field, which stores a row nobody can read.
const prose = z.string().trim().min(1);

/* An empty string is how the draft-07 schema says "none", and absence is taken
   the same way: a model that omits one wrote a thinner report, not a broken one,
   and failing the call would discard the fields it did fill in. */
const optionalProse = z
  .string()
  .optional()
  .transform((s) => s?.trim())
  .transform((s) => (s === "" ? undefined : s));

const RECORD_HYPOTHESIS_INPUT = z.object({
  statement: prose,
  verdict: z.enum([
    "root_cause",
    "trigger",
    "symptom",
    "contributing_factor",
    "disproven",
  ]),
  // Allowed to be blank: the finding is the model's reasoning, and an empty one
  // is a thin record rather than an unreadable one.
  finding: z.string(),
  evidenceIds: z.array(z.string()).min(1),
});

const SUBMIT_REPORT_INPUT = z.object({
  headline: optionalProse,
  affected: optionalProse,
  summary: prose,
  timeline: z.array(
    z.object({
      at: prose,
      what: prose,
      lane: z.enum(["change", "signal", "agent"]).optional(),
      evidenceId: optionalProse,
    }),
  ),
  impact: optionalProse,
  recommendation: optionalProse,
});

// Names the fields that failed: the model gets exactly one more attempt, and
// "invalid input" tells it nothing about which one.
function malformed(message: string): ToolExecuteResult {
  return { content: message, toolOutcome: "system" };
}

function fieldErrors(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path === "" ? issue.message : `${path}: ${issue.message}`;
    })
    .join("; ");
}

// A refusal is the record holding its ground, not a fault: the tool worked and
// what was asked for is not available.
function toResult(recording: RecordOutcome): ToolExecuteResult {
  return recording.recorded
    ? { content: recording.message }
    : { content: recording.message, toolOutcome: "expected_miss" };
}

export const REPORT_TOOLS: Tool[] = [
  {
    schema: RECORD_HYPOTHESIS_SCHEMA,
    effect: "read",
    policy: "auto",
    // Citable: a claim may rest on the call that recorded it, and what that
    // shows is its own sentence rather than a measurement to draw.
    evidenceKind: "text",
    on: "api",
    execute: async (input, ctx): Promise<ToolExecuteResult> => {
      const parsed = RECORD_HYPOTHESIS_INPUT.safeParse(input);
      if (!parsed.success) {
        // Citations get their own sentence: it is the rule most often broken and
        // the only one where the fix is "go and cite a call you made".
        const citations = parsed.error.issues.some((i) =>
          i.path.includes("evidenceIds"),
        )
          ? " A verdict needs at least one citation: pass the ids of the tool calls whose results settled it."
          : "";
        return malformed(
          `That hypothesis could not be recorded - ${fieldErrors(parsed.error)}.${citations}`,
        );
      }
      return toResult(recordHypothesis(ctx.sessionId, parsed.data));
    },
  },
];

/* Never in the toolset: the loop attaches this one schema, alone, on the
   report turn. Offering it alongside the investigation tools would let a
   run write itself up in the middle of working. */
export const SUBMIT_REPORT_TOOL: Tool = {
  schema: SUBMIT_INVESTIGATION_REPORT_SCHEMA,
  effect: "read",
  policy: "auto",
  evidenceKind: "text",
  on: "api",
  execute: async (input, ctx): Promise<ToolExecuteResult> => {
    const parsed = SUBMIT_REPORT_INPUT.safeParse(input);
    if (!parsed.success) {
      return malformed(
        `That report could not be recorded - ${fieldErrors(parsed.error)}. A report needs a summary and a timeline array, which may be empty.`,
      );
    }
    const { headline, affected, summary, timeline, impact, recommendation } =
      parsed.data;
    return toResult(
      submitReport(ctx.sessionId, {
        ...(headline !== undefined && { headline }),
        ...(affected !== undefined && { affected }),
        summary,
        timeline: timeline.map((entry) => ({
          at: entry.at,
          what: entry.what,
          ...(entry.lane !== undefined && { lane: entry.lane }),
          ...(entry.evidenceId !== undefined && {
            evidenceId: entry.evidenceId,
          }),
        })),
        impact: impact ?? "",
        recommendation: recommendation ?? "",
      }),
    );
  },
};
