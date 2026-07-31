import type { Tool } from "./types.js";

export const INTERRUPT_TOOLS: Tool[] = [
  {
    schema: {
      name: "AskUserQuestion",
      description:
        "Suspend the investigation and ask the on-call engineer a clarifying question. The UI always offers a free-text 'Other' answer alongside your options, do not add one of your own. List only the specific, named choices.",
      input_schema: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The specific question to ask.",
          },
          options: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "Short option label." },
                description: {
                  type: "string",
                  description: "What this option means.",
                },
              },
              required: ["label", "description"],
            },
            description:
              "Selectable answers for the question. Do not include a catch-all option like 'Other' or 'None of the above' - the UI adds that automatically.",
          },
          multiSelect: {
            type: "boolean",
            description: "True if multiple options may be selected.",
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
