/**
 * User interaction tool for feasibility assessment.
 */

import { Type } from "@google/genai";
import { askFeasibilityQuestion } from "../utils/prompts";
import { addFact } from "../infrastructure/knowledge";

export const askUserDeclaration = {
  name: "ask_user",
  description:
    "Ask the user a specific question when required information is missing from infrastructure or knowledge. " +
    "Use only for specific, answerable questions that would unblock feasibility assessment. " +
    "Do not ask vague or open-ended questions.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      question: {
        type: Type.STRING,
        description: "The specific question to ask the user",
      },
    },
    required: ["question"],
  },
};

export async function askUserTool(args: {
  question: string;
}): Promise<string> {
  const answer = await askFeasibilityQuestion(args.question);

  if (answer === null) {
    return "User chose not to answer. If this information is required, assess as not feasible and state what is missing in the blocking reason.";
  }

  // Persist for future sessions
  addFact(args.question, answer);

  return answer;
}
