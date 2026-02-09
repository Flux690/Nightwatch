/**
 * User interaction prompts for the orchestrator and capabilities.
 */

import * as readline from "readline";
import { logger, trackLine } from "./logger";

// Feasibility question — used by the feasibility capability within runAgent

export async function askFeasibilityQuestion(
  question: string,
): Promise<string | null> {
  logger.feasibilityQuestion(question);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    const promptIndent = " ".repeat(13); // aligns with logger text indent
    rl.question(`${promptIndent}\x1b[36m> \x1b[0m`, (answer) => {
      trackLine(); // prompt + user answer
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === "skip" || trimmed === "") {
        console.log();
        trackLine();
        resolve(null);
      } else {
        console.log();
        trackLine();
        resolve(answer.trim());
      }
    });
  });
}

// Plan approval — used by the orchestrator after validation

export type ApprovalChoice =
  | { action: "approve" }
  | { action: "reject"; feedback: string };

export async function askPlanApproval(): Promise<ApprovalChoice> {
  logger.approvalRequired();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    const promptIndent = " ".repeat(13); // aligns with logger text indent
    rl.question(`${promptIndent}Approve plan? (y/n): `, (answer) => {
      trackLine(); // prompt + user answer
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === "y" || trimmed === "yes") {
        rl.close();
        console.log();
        trackLine();
        resolve({ action: "approve" });
      } else {
        const askFeedback = () => {
          rl.question(
            `${promptIndent}Feedback for replanning: `, // promptIndent already set above
            (feedback) => {
              trackLine(); // feedback prompt + user answer
              if (feedback.trim()) {
                rl.close();
                console.log();
                trackLine();
                resolve({ action: "reject", feedback: feedback.trim() });
              } else {
                askFeedback();
              }
            },
          );
        };
        askFeedback();
      }
    });
  });
}

// Escalation resolution — used by the orchestrator when the LLM signals escalation
// or when the circuit breaker fires

export type EscalationResolution =
  | { action: "continue"; context: string }
  | { action: "dismiss" };

export async function resolveEscalation(
  reason: string,
  neededContext: string,
): Promise<EscalationResolution> {
  logger.escalationPrompt(reason, neededContext);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    const promptIndent = " ".repeat(13); // aligns with logger text indent
    rl.question(`${promptIndent}\x1b[36m> \x1b[0m`, (answer) => {
      trackLine(); // prompt + user answer
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      console.log();
      trackLine();
      if (trimmed === "stop" || trimmed === "dismiss" || trimmed === "") {
        resolve({ action: "dismiss" });
      } else {
        resolve({ action: "continue", context: answer.trim() });
      }
    });
  });
}
