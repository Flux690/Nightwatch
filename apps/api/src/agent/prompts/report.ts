import type { ToolSchema } from "../../llm/types.js";

// Draft-07-safe under Anthropic tool-schema constraints: additionalProperties
// false everywhere, every field required, primitive enums, no length/pattern.
export const REPORT_TOOL_SCHEMA: ToolSchema = {
  name: "UpdateReport",
  description:
    "Replace the live investigation report with its complete current version. Call it early (headline + status 'investigation_incomplete') and again whenever your understanding changes: a hypothesis added or resolved, evidence found, the root cause identified. Cite evidence by the [evidence: eN] tags on tool results.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "status",
      "headline",
      "rootCause",
      "hypotheses",
      "evidence",
      "proposedFix",
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
              description: "Ids of evidence entries backing this state.",
            },
          },
        },
      },
      evidence: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "evidenceTag", "summary"],
          properties: {
            id: { type: "string" },
            evidenceTag: {
              type: "string",
              description: "The eN tag from the cited tool result, e.g. 'e3'.",
            },
            summary: { type: "string" },
          },
        },
      },
      proposedFix: {
        type: "object",
        additionalProperties: false,
        required: ["summary", "steps", "evidenceIds"],
        properties: {
          summary: { type: "string" },
          steps: { type: "array", items: { type: "string" } },
          evidenceIds: { type: "array", items: { type: "string" } },
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
- Tool results are tagged [evidence: eN]. Record evidence entries citing these tags, and reference evidence entry ids from hypotheses and the proposed fix.
- Before you finish: no hypothesis may remain "open" (resolve each to root_cause or disproven), and a root_cause hypothesis must cite at least one evidence entry. If you genuinely cannot conclude, set status "inconclusive" and record what you checked - never invent a root cause.`;

// Sent by the finish gate when the model stops with an incomplete report. The
// [NightWarden] prefix marks it as harness pushback for transcript styling.
export const GATE_NUDGE =
  '[NightWarden] The report is not complete. Resolve every open hypothesis (root_cause or disproven), make sure the root cause cites evidence, and record your conclusion via UpdateReport. If you cannot conclude, set status "inconclusive" with what you checked.';
