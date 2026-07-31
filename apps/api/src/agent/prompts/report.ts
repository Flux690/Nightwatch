import type { ToolSchema } from "../../llm/types.js";

// The one thing a citation can be. The id of the call is the only handle that
// exists, so the operator's view and the model's context name the same string.
const CITATION_DESCRIPTION =
  "The ids of the tool calls whose results back this, copied exactly as they appear on your own tool calls. Cite only calls you actually made.";

// Draft-07-safe under Anthropic tool-schema constraints: additionalProperties
// false everywhere, every field required, primitive enums, no length/pattern.
export const REPORT_TOOL_SCHEMA: ToolSchema = {
  name: "UpdateReport",
  description:
    "Replace the live investigation report with its complete current version. Call it early (headline + status 'investigation_incomplete') and again whenever your understanding changes: a hypothesis added or resolved, evidence found, the root cause identified. Back a claim by citing the ids of the tool calls that produced the evidence for it.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "status",
      "headline",
      "rootCause",
      "hypotheses",
      "recommendedFix",
    ],
    properties: {
      status: {
        type: "string",
        enum: [
          "root_cause_identified",
          "inconclusive",
          "investigation_incomplete",
        ],
        description:
          "'investigation_incomplete' while working; 'root_cause_identified' or 'inconclusive' to conclude.",
      },
      headline: {
        type: "string",
        description:
          "Short investigation title (about six words), e.g. 'payments-worker OOM after PR #482'.",
      },
      rootCause: {
        type: "object",
        additionalProperties: false,
        required: ["summary", "detail"],
        properties: {
          summary: { type: "string" },
          detail: { type: "string" },
        },
      },
      hypotheses: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "statement",
            "state",
            "confidence",
            "reason",
            "evidenceIds",
          ],
          properties: {
            id: { type: "string" },
            statement: { type: "string" },
            state: {
              type: "string",
              enum: ["root_cause", "disproven", "open"],
            },
            confidence: { type: "string", enum: ["low", "medium", "high"] },
            reason: { type: "string" },
            evidenceIds: {
              type: "array",
              items: { type: "string" },
              description: CITATION_DESCRIPTION,
            },
          },
        },
      },
      recommendedFix: {
        type: "object",
        additionalProperties: false,
        required: ["summary", "evidenceIds"],
        description:
          "What you recommend, in the present or future tense. Never a claim that something was done: actions you take are recorded automatically and shown separately.",
        properties: {
          summary: { type: "string" },
          evidenceIds: {
            type: "array",
            items: { type: "string" },
            description: CITATION_DESCRIPTION,
          },
        },
      },
    },
  },
};

// Appended to the system prompt of investigate runs only (§ mode threading).
export const REPORT_PROTOCOL = `

INVESTIGATION REPORT
You maintain a live incident report via the UpdateReport tool; it is the operator's primary view of your work.
- Call UpdateReport early: set a short headline and status "investigation_incomplete" before deep work, then again whenever your understanding changes - a new hypothesis, one disproven, the root cause found.
- Every call carries the COMPLETE report; it replaces the previous version.
- Back each hypothesis and the recommended fix with evidenceIds: the ids of the tool calls whose results support them, copied exactly from your own tool calls. The operator sees each cited result quoted under the claim it backs, so cite the call that actually shows it.
- Before you finish: no hypothesis may remain "open" (resolve each to root_cause or disproven), and a root_cause hypothesis must cite at least one tool call. If you genuinely cannot conclude, set status "inconclusive" and record what you checked - never invent a root cause.`;

// Sent by the finish gate when the model stops with an incomplete report. The
// [NightWarden] prefix marks it as harness pushback for transcript styling.
export const GATE_NUDGE =
  '[NightWarden] The report is not complete. Resolve every open hypothesis (root_cause or disproven), make sure the root cause cites evidence, and record your conclusion via UpdateReport. If you cannot conclude, set status "inconclusive" with what you checked.';
