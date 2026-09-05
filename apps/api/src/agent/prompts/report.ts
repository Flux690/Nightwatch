import type {
  GatedCall,
  Hypothesis,
  SubmittedReport,
} from "@nightwarden/shared";
import { leadingHypothesis, supersededIds } from "@nightwarden/shared";
import type { RecordGap } from "../report.js";

// Short on purpose: the tool description sits next to the decision, while this
// competes with a long context by turn fifteen.
export const REPORT_PROTOCOL = `

You are also keeping a record of this investigation.

Each time you settle a candidate explanation - whether it held up or not - call RecordHypothesis with what you tested, the verdict, what the evidence showed, and the ids of the calls that showed it. A hypothesis you ruled out is worth as much to the user as the one that held.

The record is append-only. Nothing you record can be removed or rewritten, so a claim you later disagree with stays on the record beside the one that replaced it.

If you could not work out the cause, record what you tested and say so; that is an honest and useful ending, and inventing a cause to avoid it is not.

Record what you settle as you settle it, while the results are still in front of you. When you stop calling tools your investigation is over, and the turn that follows offers one tool and nothing else: you write the report there, and you cannot add to your record from it. Anything you meant to record and did not is lost at that point.`;

function sentenceFor(gap: RecordGap): string {
  switch (gap.kind) {
    case "empty_record":
      return "You have recorded nothing. Call RecordHypothesis for each explanation you considered, with the verdict it earned, so the record says what you settled, including what you ruled out. If you could not work out the cause, record what you tested and settle it as disproven; that is an honest ending, and inventing a cause to avoid it is not.";
    case "unaccounted_calls": {
      const one = gap.calls === 1;
      return `Nothing on the record accounts for the ${gap.calls} tool ${one ? "call" : "calls"} you answered after your last claim. Call RecordHypothesis for whatever ${one ? "it" : "they"} settled, including anything you ruled out, which is recorded as disproven. If ${one ? "it" : "they"} settled nothing, say that plainly and finish.`;
    }
  }
}

// Asks for a recommendation rather than another attempt: repeating a write
// that did not work is the failure this gate exists to catch.
const RECOVERY_SENTENCE =
  "Nothing can confirm whether the condition that opened this investigation has recovered. Check it yourself if you have a way to, and say what the user should do in your recommendation. Do not repeat a write that has already run.";

// Asks rather than insists: a run pushed into recording something it has not
// tested records a guess, which the record must never hold.
export function recordCheck(callsSinceClaim: number): string {
  return `You have answered ${callsSinceClaim} tool calls since your last recorded claim. If any of what you have read has settled a candidate explanation - including one you have ruled out - record it now with RecordHypothesis, while the results are still close to hand. If you are still narrowing and have settled nothing yet, carry on; this is a question, not an instruction.`;
}

// Names the gaps and nothing else: a model one finding short is not told
// about the four things it did do.
export function recordGapsMessage(gaps: RecordGap[]): string {
  return [
    "Your investigation record is not finished.",
    ...gaps.map(sentenceFor),
  ].join(" ");
}

// Told, not inferred: verdict, recency and supersession decide it together, and
// a model reading a flat list will sometimes lead with one already replaced.
function findingLine(
  h: Hypothesis,
  leadingId: string | null,
  replaced: Set<string>,
): string {
  const cites =
    h.evidenceIds.length > 0
      ? h.evidenceIds.join(", ")
      : "nothing that resolved";
  const standing = replaced.has(h.id)
    ? " (replaced, and still on the record)"
    : h.id === leadingId
      ? " (this is what the investigation stands behind)"
      : "";
  return `${h.id} [${h.verdict}]${standing} ${h.statement}\n    ${h.finding}\n    cites: ${cites}`;
}

function writeLine(call: GatedCall): string {
  const target = call.target === null ? "" : ` ${call.target}`;
  return `${call.at}  ${call.toolName}${target}  ${call.decision}`;
}

/* Each says that nothing found is a real answer, because a heading a model must
   fill is one it will invent for. */
const REPORT_RUBRIC = `Account for each of these. "None found" is a complete answer to any of them, and an honest one; never invent something to fill a line.

- The root cause: the underlying condition that made this possible.
- The trigger: the event that set it off.
- Contributing factors: what made it worse or more likely without causing it. List every one you found, not just the first.
- Symptoms: what the user or the services downstream actually saw.
- What you ruled out: the explanations you tested and rejected, which is what stops the next person repeating your work.
- Impact: who was affected and for how long.
- Recommendation: what the user should do now.`;

// Labelled, because a model shown an unattributed report cannot tell whose
// words it is reading, and revising your own work is the point.
function previousReportBlock(previous: SubmittedReport): string {
  const lines = [
    previous.headline === undefined ? null : `headline: ${previous.headline}`,
    previous.affected === undefined ? null : `affected: ${previous.affected}`,
    `summary: ${previous.summary}`,
    `timeline: ${previous.timeline.length} ${previous.timeline.length === 1 ? "entry" : "entries"}`,
    previous.impact === "" ? null : `impact: ${previous.impact}`,
    previous.recommendation === ""
      ? null
      : `recommendation: ${previous.recommendation}`,
  ].filter((line): line is string => line !== null);
  return `<previous-report written="${previous.submittedAt}">
You wrote this at the end of your last run on this investigation. Revise it in
light of what you have since learned: keep what still holds, change what does
not, and do not start from nothing. What you submit replaces it entirely, so
anything you leave out is lost.

${lines.join("\n")}
</previous-report>`;
}

// Repeated here rather than left to context: the timeline copies these handles
// verbatim, and turn forty is a bad place to copy one from.
export function reportRequest(
  hypotheses: Hypothesis[],
  writes: GatedCall[],
  unrecovered: boolean,
  previous: SubmittedReport | null = null,
): string {
  // A run that reached here with nothing recorded exhausted the gate's requests.
  // Saying so beats printing an empty heading it might write around.
  const leadingId = leadingHypothesis(hypotheses)?.id ?? null;
  const replaced = supersededIds(hypotheses);
  const findings =
    hypotheses.length === 0
      ? "RECORDED FINDINGS\nnone. Say plainly that no cause was established."
      : `RECORDED FINDINGS\n${hypotheses
          .map((h) => findingLine(h, leadingId, replaced))
          .join("\n")}`;
  const sections = [
    previous === null
      ? "Your investigation is over. Write it up for the user who will read it in the morning."
      : "This investigation has gone further since you last wrote it up. Write it up again, for the user who will read it in the morning.",
    findings,
  ];
  if (previous !== null) sections.push(previousReportBlock(previous));
  if (writes.length > 0) {
    sections.push(`RELEASED WRITES\n${writes.map(writeLine).join("\n")}`);
  }
  if (unrecovered) sections.push(RECOVERY_SENTENCE);
  sections.push(REPORT_RUBRIC);
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

// Not "continue": that invites more investigating when there is nothing left
// to find. Server-side, or it drifts from reportRequest.
export const REPORT_RETRY_REQUEST =
  "Your investigation is over and its record is complete, but the report was never written. Do not investigate further and do not call any other tool. Write it up now.";
