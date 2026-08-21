import type { GatedCall, Hypothesis } from "@nightwarden/shared";
import type { ReportGap } from "../report.js";
import type { ToolSchema } from "../../llm/types.js";

// The one thing a citation can be. The id of the call is the only handle that
// exists, so the user's view and the model's context name the same string.
const CITATION_DESCRIPTION =
  "The ids of the tool calls whose results support this claim, copied exactly as they appear on your own calls. Cite only calls you actually made. The user sees each cited result shown underneath the claim it backs, so cite the call whose output actually shows what you are asserting.";

// Draft-07-safe under Anthropic tool-schema constraints: additionalProperties
// false everywhere, every field required, primitive enums, no length/pattern.
// An optional value is therefore a required field whose empty string means none.
export const RECORD_HYPOTHESIS_SCHEMA: ToolSchema = {
  name: "RecordHypothesis",
  description:
    "Record a candidate explanation you have tested, and what testing it showed. Call this each time you settle one, including the ones that turned out to be wrong: what you ruled out is what stops the user repeating your work at three in the morning. The record is append-only, so if your understanding changes later, record the new hypothesis rather than trying to correct this one.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    /* Reasoning before conclusion. A schema whose answer field precedes its
       reasoning field makes the model commit before it explains, which
       measurably degrades the reasoning (Tam et al., EMNLP 2024). Under strict
       decoding the order binds; without it, it still leads. */
    required: ["statement", "finding", "evidenceIds", "verdict"],
    properties: {
      statement: {
        type: "string",
        description:
          "The explanation you tested, stated so that it can be proved or disproved. Name the thing you mean: a container, a file, a metric, a commit. 'Check database connectivity' says nothing; 'the cache bump in PR #482 leaks memory in payments-worker' can be tested.",
      },
      finding: {
        type: "string",
        description:
          "What the cited results actually showed, and why that settles it this way, in complete sentences. This is read beneath your statement by someone who was not here, so it has to explain rather than remind: quote the value, the line or the timestamp that decided it, and say what it means. Two or three sentences is usually right; a fragment is not.",
      },
      evidenceIds: {
        type: "array",
        items: { type: "string" },
        description: `${CITATION_DESCRIPTION} At least one is required, on every verdict: a claim nothing backs is a guess, and so is a dismissal.`,
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
    },
  },
};

export const SUBMIT_INVESTIGATION_REPORT_SCHEMA: ToolSchema = {
  name: "SubmitInvestigationReport",
  description:
    "Write up the investigation you have just finished, for the user who will read it in the morning. Your findings are already on the record and are rendered beneath what you write here, so do not restate them: no verdicts, no hypotheses, no re-copied citations. Write the things the record has no room for.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "headline",
      "affected",
      "summary",
      "timeline",
      "impact",
      "recommendation",
    ],
    properties: {
      headline: {
        type: "string",
        description:
          "One sentence, under about 120 characters, naming what broke and why. This is the line someone reads at three in the morning before deciding whether to get up, and often the only line they read. State the cause, not the symptom: 'the retry loop added in PR #482 exhausted the payments-api connection pool', never 'payments-api returned errors'.",
      },
      affected: {
        type: "string",
        description:
          "A short noun phrase naming who or what was hit, for the band at the top of the report: 'the checkout path', 'all payments-api pods in prod'. Not a sentence, and not a duplicate of the impact field below, which says for how long and how badly.",
      },
      summary: {
        type: "string",
        description:
          "Two or three sentences expanding the headline: what broke, why, and where it stands now. Name the service, the value and the change.",
      },
      timeline: {
        type: "array",
        description:
          "What happened, earliest first. Include only moments that matter: the change that set it up, the failure, and anything you did about it. Every write you released is added for you, so do not list those.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["at", "what", "lane", "evidenceId"],
          properties: {
            at: {
              type: "string",
              description:
                "When it happened, as an ISO 8601 timestamp taken from a tool result, an alert, or a commit. Never a guess.",
            },
            what: {
              type: "string",
              description: "One sentence, in the past tense.",
            },
            lane: {
              type: "string",
              enum: ["change", "signal", "agent"],
              description:
                "Which strand this moment belongs to. 'change' is something a human or a deploy did to the system: a merge, a rollout, a config edit. 'signal' is the system reacting: an alert firing, a metric crossing a threshold, a pod restarting. 'agent' is something you did while investigating. Writes you released are added for you and are not any of these.",
            },
            evidenceId: {
              type: "string",
              description:
                "The id of the tool call that shows this happened, or an empty string when no single call does.",
            },
          },
        },
      },
      impact: {
        type: "string",
        description:
          "Who or what was affected and for how long, in a sentence. If you cannot tell from what you read, say so plainly rather than estimating.",
      },
      recommendation: {
        type: "string",
        description:
          "What the user should do, in the present or future tense, never as a claim that something has already been done: what you ran is recorded separately and shown to them. If a write you released already fixed it, say what would stop it recurring.",
      },
    },
  },
};

// Appended to the system prompt of a session under investigation only. Short on
// purpose: the tool description sits next to the decision, while this competes
// with a long context by turn fifteen.
export const REPORT_PROTOCOL = `

You are also keeping a record of this investigation.

Each time you settle a candidate explanation - whether it held up or not - call RecordHypothesis with what you tested, the verdict, what the evidence showed, and the ids of the calls that showed it. A hypothesis you ruled out is worth as much to the user as the one that held.

Be specific. A finding should name a value, a file, a container, a commit or a log line. "Check database connectivity" is worthless to the person reading this at three in the morning.

The record is append-only. Nothing you record can be removed or rewritten, so a claim you later disagree with stays on the record beside the one that replaced it.

If you could not work out the cause, record what you tested and say so; that is an honest and useful ending, and inventing a cause to avoid it is not.`;

// Grammar for a list of row ids, so a request naming one gap and a request
// naming several both read as English.
function subject(ids: string[]): { names: string; is: string; them: string } {
  if (ids.length === 1) return { names: ids[0]!, is: "is", them: "it" };
  const names = `${ids.slice(0, -1).join(", ")} and ${ids[ids.length - 1]!}`;
  return { names, is: "are", them: "each of them" };
}

function sentenceFor(gap: ReportGap): string {
  switch (gap.kind) {
    case "empty_record":
      return "You have recorded nothing. Call RecordHypothesis for each explanation you considered, with the verdict it earned, so the record says what you ruled out. If you could not work out the cause, record what you tested and settle it as disproven; that is an honest ending, and inventing a cause to avoid it is not.";
    case "unresolvable_citation": {
      const s = subject(gap.ids);
      return `${s.names} ${s.is} backed only by calls that returned nothing, so the claim stands unsupported. Record ${s.them} again against a call that answered.`;
    }
  }
}

/* A write ran and nothing has been recommended. Asks for a recommendation rather
   than another attempt: repeating a write that did not work is the failure this
   gate catches, and a record ending with neither leaves the user nothing. */
const RECOVERY_SENTENCE =
  "Nothing can confirm whether the condition that opened this investigation has recovered. Check it yourself if you have a way to, and say what the user should do in your recommendation. Do not repeat a write that has already run.";

// Sent by the finish gate when a run tries to end with gaps in its record. It
// names those gaps and nothing else: a model that is one finding short is not
// told about the four things it did do.
export function completionRequest(gaps: ReportGap[]): string {
  return [
    "Your investigation record is not finished.",
    ...gaps.map(sentenceFor),
  ].join(" ");
}

function findingLine(h: Hypothesis): string {
  const cites =
    h.evidenceIds.length > 0
      ? h.evidenceIds.join(", ")
      : "nothing that resolved";
  return `${h.id} [${h.verdict}] ${h.statement}\n    ${h.finding}\n    cites: ${cites}`;
}

function writeLine(call: GatedCall): string {
  const target = call.target === null ? "" : ` ${call.target}`;
  return `${call.at}  ${call.toolName}${target}  ${call.decision}`;
}

// The ledger is repeated here rather than left to context: the timeline cites
// call ids verbatim, and a forty-turn context is a bad place to copy one from.
export function reportRequest(
  hypotheses: Hypothesis[],
  writes: GatedCall[],
  unrecovered: boolean,
): string {
  // A run that reached here with nothing recorded exhausted the gate's requests.
  // Saying so beats printing an empty heading it might write around.
  const findings =
    hypotheses.length === 0
      ? "RECORDED FINDINGS\nnone. Say plainly that no cause was established."
      : `RECORDED FINDINGS\n${hypotheses.map(findingLine).join("\n")}`;
  const sections = [
    "Your investigation is over. Write it up for the user who will read it in the morning.",
    findings,
  ];
  if (writes.length > 0) {
    sections.push(`RELEASED WRITES\n${writes.map(writeLine).join("\n")}`);
  }
  if (unrecovered) sections.push(RECOVERY_SENTENCE);
  sections.push(
    "Call SubmitInvestigationReport once. The findings above are rendered beneath what you write, so write only the summary, the timeline, the impact and the recommendation.",
  );
  return sections.join("\n\n");
}

// The report turn came back wrong. One sentence naming what to fix, and the
// same tool offered again - there is nothing else it can do from here.
export function reportRetry(problem: string): string {
  return `${problem} Call SubmitInvestigationReport again.`;
}

/* Deliberately not "continue": that invites more investigating, and there is
   nothing left to find. Server-side because it is prompt text - composed in the
   console it would drift from reportRequest the first time either was edited. */
export const REPORT_RETRY_REQUEST =
  "Your investigation is over and its record is complete, but the report was never written. Do not investigate further and do not call any other tool. Write it up now.";
