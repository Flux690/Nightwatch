/**
 * Command validation for safety constraints.
 * Validates argument arrays — no shell is involved (execFile),
 * so shell-operator checks are unnecessary.
 */

export class CommandValidationError extends Error {
  constructor(
    public command: string,
    public reason: string,
  ) {
    super(reason);
    this.name = "CommandValidationError";
  }
}

function findTargetContainer(
  args: string[],
  knownContainers: Set<string>,
): string | null {
  let found: string | null = null;
  let count = 0;

  for (const name of knownContainers) {
    if (args.includes(name)) {
      found = name;
      count++;
    }
  }

  return count === 1 ? found : null;
}

export function validateCommand(
  args: string[],
  knownContainers: Set<string>,
): void {
  const display = args.join(" ");

  if (args.length === 0) {
    throw new CommandValidationError(display, "Empty command not allowed");
  }

  // Must be docker CLI
  if (args[0] !== "docker") {
    throw new CommandValidationError(
      display,
      "Command must start with 'docker'",
    );
  }

  // Block shell invocation inside docker exec (container-side concern)
  const execIndex = args.indexOf("exec");
  if (execIndex !== -1) {
    const argsAfterExec = args.slice(execIndex + 1);
    // Skip flags and find the container name, then the executed command
    let cmdStart = 0;
    for (let i = 0; i < argsAfterExec.length; i++) {
      if (!argsAfterExec[i].startsWith("-")) {
        cmdStart = i + 1; // skip the container name
        break;
      }
    }
    const execCommand = argsAfterExec.slice(cmdStart);
    if (execCommand.length > 0) {
      const cmd = execCommand[0].toLowerCase();
      if (
        cmd === "sh" ||
        cmd === "bash" ||
        cmd === "/bin/sh" ||
        cmd === "/bin/bash"
      ) {
        throw new CommandValidationError(
          display,
          "Shell invocation not allowed inside docker exec",
        );
      }
    }
  }

  // Single container targeting
  const target = findTargetContainer(args, knownContainers);

  if (!target) {
    const matches = Array.from(knownContainers).filter((c) =>
      args.includes(c),
    );

    if (matches.length === 0) {
      throw new CommandValidationError(
        display,
        "Command does not reference any known container",
      );
    }

    throw new CommandValidationError(
      display,
      `Command references multiple containers: ${matches.join(", ")}`,
    );
  }
}

/**
 * Assert that a collection of commands is safe to execute.
 * This function is intent-agnostic (remediation vs verification).
 */
export function assertCommandsValid(
  steps: { action: string[] }[],
  knownContainers: string[],
): void {
  const containerSet = new Set(knownContainers);

  for (const step of steps) {
    validateCommand(step.action, containerSet);
  }
}
