import type { ReportGap } from "../report.js";
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

// A settled hypothesis can never be settled again, so a claim whose evidence
// did not hold up is recorded afresh rather than corrected in place. Both gaps
// below say so, because asking for a call the system refuses teaches nothing.
const RECORD_AGAIN =
  "A settled hypothesis cannot be settled again, so propose it afresh with ProposeHypothesis and settle the new one with ResolveHypothesis";

// Grammar for a list of row ids, so a request naming one gap and a request
// naming four both read as English.
function subject(ids: string[]): { names: string; is: string; them: string } {
  if (ids.length === 1) return { names: ids[0]!, is: "is", them: "it" };
  const names = `${ids.slice(0, -1).join(", ")} and ${ids[ids.length - 1]!}`;
  return { names, is: "are", them: "each of them" };
}

function sentenceFor(gap: ReportGap): string {
  switch (gap.kind) {
    case "empty_record":
      return "You have recorded no hypotheses. Call ProposeHypothesis for each explanation you considered and ResolveHypothesis to settle it, so the record says what you ruled out. If you could not work out the cause, say what you tested and settle it as disproven; that is an honest ending, and inventing a cause to avoid it is not.";
    case "open_hypothesis": {
      const s = subject(gap.ids);
      return `${s.names} ${s.is} still open. Settle ${s.them} with ResolveHypothesis.`;
    }
    case "uncited_root_cause": {
      const s = subject(gap.ids);
      return `${s.names} ${s.is} settled as a root cause while citing no tool call. ${RECORD_AGAIN}, citing the ids exactly as they appear on your own calls.`;
    }
    case "unresolvable_citation": {
      const s = subject(gap.ids);
      return `${s.names} ${s.is} backed only by calls that returned nothing, so the claim stands unsupported. ${RECORD_AGAIN} against a call that answered; for a proposed fix, call ProposeFix again.`;
    }
  }
}

/* A write ran and nothing has been recommended. Both sentences ask for a
   recommendation rather than another fix attempt: the operator may have to act,
   and a record ending with neither a recovery nor an instruction leaves them
   nothing. Neither says "try again" - repeating a write that did not work is the
   failure this gate exists to catch.

   They are two sentences because they are two different facts. Telling the model
   the condition is still firing when nothing could answer is a claim we cannot
   support, in a system whose whole premise is not asserting what it cannot
   verify. */
const RECOVERY_SENTENCE: Record<"still_firing" | "unconfirmed", string> = {
  still_firing:
    "The condition that opened this investigation is still firing, and you have recommended nothing. Call ProposeFix with what the operator should do about it. Do not repeat a write that has already run.",
  unconfirmed:
    "Nothing can confirm whether the condition that opened this investigation has recovered, and you have recommended nothing. Check it yourself if you have a way to, and call ProposeFix with what the operator should do. Do not repeat a write that has already run.",
};

// Sent by the finish gate when a run tries to end with gaps in its record. It
// names those gaps and nothing else: a model that is one hypothesis short is not
// told about the four things it did do.
export function completionRequest(
  gaps: ReportGap[],
  recovery: keyof typeof RECOVERY_SENTENCE | null = null,
): string {
  return [
    "Your investigation record is not finished.",
    ...gaps.map(sentenceFor),
    ...(recovery === null ? [] : [RECOVERY_SENTENCE[recovery]]),
  ].join(" ");
}
