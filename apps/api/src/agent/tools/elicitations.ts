import type { ToolSchema } from "../../llm/types.js";

// Offered to the model as a tool because tool-calling is its only channel, but
// modelled as neither: the result comes from a person, so there is nothing to
// execute and no policy a user rule could switch off.
export interface Elicitation {
  schema: ToolSchema;
}

/* Four, and the person always gets a free-text box beside them, so the card
   offers five rows. Beyond that a question stops being answerable at a glance,
   which is the only reason to interrupt someone with one. */
export const MAX_QUESTION_OPTIONS = 4;

/* Refused whole rather than trimmed to fit. Keeping four and dropping the rest
   would hide a choice the person might have needed, and nothing else here shows
   less than it found without saying so. */
export function questionOptionOverflow(
  input: Record<string, unknown>,
): string | null {
  const options = input["options"];
  if (!Array.isArray(options) || options.length <= MAX_QUESTION_OPTIONS)
    return null;
  return `You offered ${options.length} options and at most ${MAX_QUESTION_OPTIONS} can be shown. Ask again with the ${MAX_QUESTION_OPTIONS} that most change what happens next; the user is given a free-text box as well, so a rarer answer is not lost by leaving it out.`;
}

export const ELICITATIONS: Elicitation[] = [
  {
    schema: {
      name: "AskUserQuestion",
      description:
        "Pause and ask the on-call engineer a question you cannot answer from the tools. Use it when you need a decision or a piece of context only a human holds, not to check work you could verify yourself. Your question is the reason you are interrupting them, so make it specific enough to answer in one click.",
      input_schema: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description:
              "The question to ask, phrased so it can be answered directly.",
          },
          options: {
            type: "array",
            maxItems: MAX_QUESTION_OPTIONS,
            items: {
              type: "object",
              properties: {
                label: {
                  type: "string",
                  description: "A short label for this answer.",
                },
                description: {
                  type: "string",
                  description: "What choosing this answer would mean.",
                },
              },
              required: ["label", "description"],
            },
            description: `The answers to offer, at most ${MAX_QUESTION_OPTIONS}. List only specific, named choices. Never add a catch-all such as 'Other' or 'None of the above': the user is always given a free-text box alongside your options, so adding one of your own only duplicates it.`,
          },
          multiSelect: {
            type: "boolean",
            description:
              "Set this to true if more than one option may be chosen at once.",
          },
        },
        required: ["question", "options"],
      },
    },
  },
];
