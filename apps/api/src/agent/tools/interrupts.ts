import type { Tool } from "./types.js";

export const INTERRUPT_TOOLS: Tool[] = [
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
            description:
              "The answers to offer. List only specific, named choices. Never add a catch-all such as 'Other' or 'None of the above': the operator is always given a free-text box alongside your options, so adding one of your own only duplicates it.",
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
    access: "ask",
    on: "api",
    execute: async () => ({
      content:
        "AskUserQuestion is an interrupt and cannot be executed directly.",
      outcome: "system",
    }),
  },
];
