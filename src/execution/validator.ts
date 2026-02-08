/**
 * Command validation for safety constraints.
 * Ensures commands are Docker-only, single-container, and free of shell injection.
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

/**
 * Blocked patterns with descriptive reasons.
 * Each pattern is checked against commands to prevent unsafe operations.
 */
const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Command must start with docker
  { pattern: /^(?!docker\s)/i, reason: "Command must start with 'docker'" },

  // Shell invocation
  { pattern: /\bsh\s+-c\b/i, reason: "Shell invocation not allowed" },
  { pattern: /\bbash\s+-c\b/i, reason: "Shell invocation not allowed" },

  // Pipes and redirection
  { pattern: /\|/, reason: "Pipes not allowed" },
  { pattern: />/, reason: "Output redirection not allowed" },
  { pattern: /</, reason: "Input redirection not allowed" },

  // Command substitution
  { pattern: /\$\(/, reason: "Command substitution not allowed" },
  { pattern: /`/, reason: "Backtick substitution not allowed" },

  // Command chaining
  { pattern: /&&/, reason: "Command chaining (&&) not allowed" },
  { pattern: /\|\|/, reason: "Command chaining (||) not allowed" },
  { pattern: /;/, reason: "Command chaining (;) not allowed" },

  // Variable assignment
  {
    pattern: /\b[a-zA-Z_][a-zA-Z0-9_]*=/,
    reason: "Variable assignment not allowed",
  },

  // Subshells
  { pattern: /\(/, reason: "Subshell not allowed" },
  { pattern: /\)/, reason: "Subshell not allowed" },

  // Destructive patterns
  { pattern: /rm\s+-rf\s+\//, reason: "Destructive rm pattern blocked" },
  { pattern: /rm\s+-rf\s+\/\*/, reason: "Destructive rm pattern blocked" },
  { pattern: /dd\s+if=/, reason: "Destructive dd pattern blocked" },
  { pattern: /mkfs(\.\w+)?/, reason: "Filesystem formatting blocked" },
  { pattern: />\s*\/dev\/sd[a-z]/, reason: "Direct disk write blocked" },

  // Remote code execution
  {
    pattern: /curl\s+.*\|\s*(bash|sh)/i,
    reason: "Remote code execution blocked",
  },
  {
    pattern: /wget\s+.*\|\s*(bash|sh)/i,
    reason: "Remote code execution blocked",
  },
];

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findTargetContainer(
  command: string,
  knownContainers: Set<string>,
): string | null {
  let found: string | null = null;
  let count = 0;

  for (const name of knownContainers) {
    const pattern = new RegExp(`\\b${escapeRegex(name)}\\b`);
    if (pattern.test(command)) {
      found = name;
      count++;
    }
  }

  return count === 1 ? found : null;
}

export function validateCommand(
  command: string,
  knownContainers: Set<string>,
): void {
  const trimmed = command.trim();

  // Check for empty command
  if (!trimmed) {
    throw new CommandValidationError(command, "Empty command not allowed");
  }

  // Check all blocked patterns
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) {
      throw new CommandValidationError(command, reason);
    }
  }

  // Check single container targeting
  const target = findTargetContainer(trimmed, knownContainers);

  if (!target) {
    const matches = Array.from(knownContainers).filter((c) =>
      new RegExp(`\\b${escapeRegex(c)}\\b`).test(trimmed),
    );

    if (matches.length === 0) {
      throw new CommandValidationError(
        command,
        "Command does not reference any known container",
      );
    }

    throw new CommandValidationError(
      command,
      `Command references multiple containers: ${matches.join(", ")}`,
    );
  }
}

/**
 * Assert that a collection of commands is safe to execute.
 * This function is intent-agnostic (remediation vs verification).
 */
export function assertCommandsValid(
  steps: { action: string }[],
  knownContainers: string[],
): void {
  const containerSet = new Set(knownContainers);

  for (const step of steps) {
    validateCommand(step.action, containerSet);
  }
}
