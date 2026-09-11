import type { StopReason, ToolResult } from "../../llm/types.js";

/* Why a turn carries no usable answer, said in the transcript rather than only
   the log. Null where the turn is usable and the loop reads what it holds. */
export function turnEnding(
  reason: StopReason,
  maxOutputTokens: number,
): string | null {
  switch (reason) {
    case "done":
    case "tools":
      return null;
    case "length":
      return `The model's reply was cut off at this model's output limit of ${maxOutputTokens} tokens, so this turn is incomplete. Send a message to continue, or pick a model with a larger limit in Settings.`;
    case "filtered":
      return "The model declined to continue this investigation. Nothing further was read, and anything already recorded stands.";
    case "error":
    case "unknown":
      return "The model provider ended this turn without an answer and without saying why, so nothing was added. Send a message to continue.";
  }
}

// The same question for the report turn, which has its own deliverable to name.
export function reportEnding(
  reason: StopReason,
  maxOutputTokens: number,
): string | null {
  switch (reason) {
    case "done":
    case "tools":
      return null;
    case "length":
      return `The report was cut off at this model's output limit of ${maxOutputTokens} tokens, so it was never finished. Raise the limit or pick a model with a larger one under Settings, Provider, then try again.`;
    case "filtered":
      return "The model declined to write the report.";
    case "error":
    case "unknown":
      return "The model provider ended the report turn without an answer and without saying why.";
  }
}

/* Read from the tool's own answer: a follow-up run already holds a report, so
   the record's contents prove nothing about the turn that just ran. */
export function reportRefusal(results: readonly ToolResult[]): string | null {
  // The turn offers one tool, so the first result is the submission or there is
  // none. The tool already told the model which field was wrong.
  const [submitted] = results;
  if (submitted === undefined) {
    return "The report turn ended without calling ComposeReport.";
  }
  return submitted.isError === true ? "The report was refused." : null;
}
