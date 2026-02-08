/**
 * Command execution infrastructure.
 * Executes shell commands and tracks results.
 */

import { exec } from "child_process";
import { ExecutionResult, StepResult } from "../types";

export type CommandResult = {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
};

export function execCmd(command: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    exec(command, (error, stdout, stderr) => {
      let exitCode = 0;
      let signal: string | null = null;

      if (error) {
        exitCode = (error as NodeJS.ErrnoException).code
          ? Number((error as any).code)
          : 1;
        signal = (error as any).signal ?? null;
      }

      resolve({
        success: exitCode === 0 && !signal,
        exitCode,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

export async function executeCommands(
  steps: { action: string }[],
): Promise<ExecutionResult> {
  const results: StepResult[] = [];

  for (let i = 0; i < steps.length; i++) {
    const command = steps[i].action;
    const cmdResult = await execCmd(command);

    results.push({
      step: command,
      status: cmdResult.success ? "success" : "failure",
      exitCode: cmdResult.exitCode,
      stdout: cmdResult.stdout,
      stderr: cmdResult.stderr,
      timestamp: new Date().toISOString(),
    });

    if (!cmdResult.success) {
      return { results, failedAtStep: i };
    }
  }

  return { results, failedAtStep: -1 };
}
