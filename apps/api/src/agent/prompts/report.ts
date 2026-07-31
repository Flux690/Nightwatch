import type { ToolSchema } from "../../llm/types.js";

// The one thing a citation can be. The id of the call is the only handle that
// exists, so the operator's view and the model's context name the same string.
const CITATION_DESCRIPTION =
  "The ids of the tool calls whose results support this claim, copied exactly as they appear on your own calls. Cite only calls you actually made. The operator sees each cited result quoted underneath the claim it backs, so cite the call whose output actually shows what you are asserting.";

// Draft-07-safe under Anthropic tool-schema constraints: additionalProperties
// false everywhere, every field required, primitive enums, no length/pattern.
export const REPORT_TOOL_SCHEMA: ToolSchema = {
  name: "UpdateReport",
  description:
    "Record the state of your investigation. This is what the operator reads while you work, so keep it current. Call it early, as soon as you have a headline and before any deep work, with the status 'investigation_incomplete'. Call it again every time your understanding changes: when you propose a hypothesis, when you prove or disprove one, and when you settle on the cause. Each call must carry the complete report, because it replaces the previous version entirely. Support every hypothesis and your recommended fix by citing the ids of the tool calls whose results back them.",
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
          "Use 'investigation_incomplete' while you are still working. Finish with 'root_cause_identified' when you found the cause and can cite evidence for it, or 'inconclusive' when you could not. Both endings are legitimate.",
      },
      headline: {
        type: "string",
        description:
          "A short title for the investigation, around six words, for example 'payments-worker OOM after PR #482'.",
      },
      rootCause: {
        type: "object",
        additionalProperties: false,
        required: ["summary", "detail"],
        properties: {
          summary: {
            type: "string",
            description:
              "The cause in one sentence, naming the thing that failed.",
          },
          detail: {
            type: "string",
            description:
              "How that cause produced the symptom the alert reported, in a short paragraph.",
          },
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
            id: {
              type: "string",
              description:
                "A short identifier of your own choosing, stable across calls, so the same hypothesis keeps the same id as its state changes.",
            },
            statement: {
              type: "string",
              description:
                "The candidate explanation, stated as something that can be proved or disproved.",
            },
            state: {
              type: "string",
              enum: ["root_cause", "disproven", "open"],
              description:
                "Use 'open' while you are still testing it, then settle it on 'root_cause' or 'disproven' before you finish.",
            },
            confidence: {
              type: "string",
              enum: ["low", "medium", "high"],
              description: "How strongly the evidence supports this.",
            },
            reason: {
              type: "string",
              description:
                "Why the hypothesis is in that state, referring to what the cited results actually showed.",
            },
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
          "What you recommend the operator do, written in the present or future tense. Never write it as a claim that something has already been done: the actions you take are recorded for you automatically and shown to the operator separately.",
        properties: {
          summary: {
            type: "string",
            description: "The recommended fix, stated in a sentence or two.",
          },
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

// Appended to the system prompt of a session under investigation only. The
// sequence is stated here as well as on the tool itself: a tool description sits
// next to the decision, while this is competing with a long context by turn fifteen.
export const REPORT_PROTOCOL = `

You are also keeping a written report of this investigation, using the UpdateReport tool. It is what the operator reads while you work, so it has to stay current.

Call UpdateReport early, with a short headline and the status "investigation_incomplete", before you start any deep work. Call it again every time your understanding changes: when you propose a hypothesis, when you prove or disprove one, and when you settle on the cause. Every call carries the complete report and replaces the previous version, so include everything you still believe, not only what changed.

Support each hypothesis and your recommended fix with evidenceIds, which are the ids of the tool calls whose results back them, copied exactly from your own calls. The operator sees each cited result quoted directly underneath the claim it supports, so cite the call whose output actually shows what you are claiming.

Before you finish, no hypothesis may still be "open": settle each one on "root_cause" or "disproven". A hypothesis you settle as the root cause must cite at least one tool call. If you genuinely could not work out the cause, set the status to "inconclusive" and record what you checked. That is an honest and useful ending. Never invent a cause to avoid it.`;

// Sent by the finish gate when a run stops with an incomplete report. It is
// persisted as a user-role message, so the operator currently sees it.
export const GATE_NUDGE =
  'Your report is not finished yet. Settle every hypothesis still marked "open" on either "root_cause" or "disproven", make sure the hypothesis you settled as the root cause cites at least one tool call, and record all of that with UpdateReport. If you could not work out the cause, set the status to "inconclusive" and say what you checked.';
