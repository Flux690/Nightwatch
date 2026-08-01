import type { ToolSchema } from "../../llm/types.js";

// The one thing a citation can be. The id of the call is the only handle that
// exists, so the operator's view and the model's context name the same string.
const CITATION_DESCRIPTION =
  "The ids of the tool calls whose results support this claim, copied exactly as they appear on your own calls. Cite only calls you actually made. The operator sees each cited result quoted underneath the claim it backs, so cite the call whose output actually shows what you are asserting.";

// Draft-07-safe under Anthropic tool-schema constraints: additionalProperties
// false everywhere, every field required, primitive enums, no length/pattern.
export const PROPOSE_HYPOTHESIS_SCHEMA: ToolSchema = {
  name: "ProposeHypothesis",
  description:
    "Record a candidate explanation you are about to test. Call this the moment you have one, before you go looking for the evidence, and call it again for each further explanation you consider. It costs one sentence and it is what the operator watches while you work. NightWarden assigns the hypothesis an id and returns it; you will need that id to resolve it later.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["statement"],
    properties: {
      statement: {
        type: "string",
        description:
          "The candidate explanation, stated so that it can be proved or disproved. Name the thing you mean: a container, a file, a metric, a commit. 'Check database connectivity' says nothing; 'the cache bump in PR #482 leaks memory in payments-worker' can be tested.",
      },
    },
  },
};

export const RESOLVE_HYPOTHESIS_SCHEMA: ToolSchema = {
  name: "ResolveHypothesis",
  description:
    "Settle a hypothesis you proposed earlier, once its evidence is in. Every hypothesis must be settled before you finish. A hypothesis can only be settled once and cannot be settled again, so if your understanding changes, propose a new hypothesis instead.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["id", "verdict", "finding", "evidenceIds"],
    properties: {
      id: {
        type: "string",
        description:
          "The id NightWarden returned when you proposed this hypothesis.",
      },
      verdict: {
        type: "string",
        enum: [
          "root_cause",
          "trigger",
          "symptom",
          "contributing_factor",
          "disproven",
        ],
        description:
          "'root_cause' is the underlying condition that made the failure possible. 'trigger' is the event that set it off. 'symptom' is something the real cause produced downstream. 'contributing_factor' made the failure worse or more likely without causing it. 'disproven' means you tested it and it is not so. Most published analyses identify a trigger rather than a root cause, so do not reach for 'root_cause' when 'trigger' or 'symptom' is what the evidence shows.",
      },
      finding: {
        type: "string",
        description:
          "What the cited results actually showed, and why that settles the hypothesis this way. Quote the value, the line or the timestamp that decided it.",
      },
      evidenceIds: {
        type: "array",
        items: { type: "string" },
        description: `${CITATION_DESCRIPTION} At least one is required: a verdict nothing backs is a guess.`,
      },
    },
  },
};

export const PROPOSE_FIX_SCHEMA: ToolSchema = {
  name: "ProposeFix",
  description:
    "Record what you recommend the operator do about the cause you found. Write it as a recommendation, in the present or future tense, never as a claim that something has already been done: the actions you take are recorded for you and shown to the operator separately. If the operator rejects a fix you proposed, call this again with the revised one; the earlier proposal stays on the record beside it.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "evidenceIds"],
    properties: {
      summary: {
        type: "string",
        description:
          "The recommended fix in a sentence or two, naming what to change and where.",
      },
      evidenceIds: {
        type: "array",
        items: { type: "string" },
        description: CITATION_DESCRIPTION,
      },
    },
  },
};

// Appended to the system prompt of a session under investigation only. The
// sequence is stated here as well as on the tools themselves: a tool description
// sits next to the decision, while this competes with a long context by turn fifteen.
export const REPORT_PROTOCOL = `

You are also keeping a record of this investigation, and the operator reads it while you work.

Each time you have a candidate explanation, call ProposeHypothesis with it before you go looking for the evidence. Once you have that evidence, call ResolveHypothesis with the id you were given, a verdict and the ids of the tool calls that back it. Both calls cost a sentence, and the record is what the operator has to go on.

Be specific. A finding should name a value, a file, a container, a commit or a log line. "Check database connectivity" is worthless to the person reading this at three in the morning.

The record is append-only. Nothing you record can be removed or rewritten, so a hypothesis you later disagree with stays on the record, settled as disproven or replaced by a new one.

When you have settled on what should be done, call ProposeFix. If the operator rejects it, propose the revised one the same way.

Before you finish, settle every hypothesis you proposed. A hypothesis you settle as the root cause must cite at least one tool call. If you could not work out the cause, settle what you tested and say so; that is an honest and useful ending, and inventing a cause to avoid it is not.`;

// Sent by the finish gate when a run stops with an incomplete record.
export const GATE_NUDGE =
  "Your investigation record is not finished. Settle every hypothesis you proposed with ResolveHypothesis, and make sure any hypothesis you settled as the root cause cites at least one tool call. If you proposed nothing, propose what you tested with ProposeHypothesis and settle it, so the record says what you ruled out.";
