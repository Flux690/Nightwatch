import { z } from "zod";
import { declareTool } from "./schema.js";
import type { ToolSchema } from "../../llm/types.js";

/* Offered as a tool because tool-calling is the only channel, but the result
   comes from a person: nothing executes, and no rule can switch it off. */
export interface Elicitation {
  schema: ToolSchema;
  // No execute to validate in, so the turn parses with this before suspending.
  input: z.ZodObject;
}

// Four plus the free-text box makes five rows. Beyond that a question stops
// being answerable at a glance, which is the only reason to ask one.
export const MAX_QUESTION_OPTIONS = 4;

// Reads as the tail of the refusal the turn renders, which names the field.
const TOO_MANY = `a card shows at most ${MAX_QUESTION_OPTIONS}. Ask again with the ${MAX_QUESTION_OPTIONS} that most change what happens next; the user is given a free-text box as well, so a rarer answer is not lost by leaving it out.`;

const ASK_USER_QUESTION_INPUT = z.object({
  question: z.string().meta({
    description: "The question to ask, phrased so it can be answered directly.",
  }),
  options: z
    .array(
      z.object({
        label: z.string().meta({
          description: "A short label for this answer.",
        }),
        description: z.string().meta({
          description: "What choosing this answer would mean.",
        }),
      }),
    )
    .max(MAX_QUESTION_OPTIONS, TOO_MANY)
    .meta({
      description: `The answers to offer, at most ${MAX_QUESTION_OPTIONS}. List only specific, named choices. Never add a catch-all such as 'Other' or 'None of the above': the user is always given a free-text box alongside your options, so adding one of your own only duplicates it.`,
    }),
  multiSelect: z.boolean().optional().meta({
    description:
      "Set this to true if more than one option may be chosen at once.",
  }),
});

export const ELICITATIONS: Elicitation[] = [
  declareTool(
    "AskUserQuestion",
    "Pause and ask the on-call engineer a question you cannot answer from the tools. Use it when you need a decision or a piece of context only a human holds, not to check work you could verify yourself. Your question is the reason you are interrupting them, so make it specific enough to answer in one click.",
    ASK_USER_QUESTION_INPUT,
  ),
];
