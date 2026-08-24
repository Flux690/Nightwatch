import type { ToolSchema } from "../../llm/types.js";

// Offered as a tool because tool-calling is the only channel, but the result
// comes from a person: nothing executes, and no rule can switch it off.
export interface Elicitation {
  schema: ToolSchema;
}

// Four plus the free-text box makes five rows. Beyond that a question stops
// being answerable at a glance, which is the only reason to ask one.
export const MAX_QUESTION_OPTIONS = 4;

// A shape error on the channel every tool error uses, like executeTool's size
// guard. Whole rather than trimmed: keeping four would hide a choice silently.
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
        additionalProperties: false,
        properties: {
          question: {
            type: "string",
            description:
              "The question to ask, phrased so it can be answered directly.",
          },
          options: {
            type: "array",
            // Prose and a runtime check, not maxItems: strict decoding rejects
            // array length constraints, and providers honoured it unevenly.
            items: {
              type: "object",
              additionalProperties: false,
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
