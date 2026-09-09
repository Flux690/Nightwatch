// Typed failures the host maps to corrective tool errors or HTTP statuses.
// The sandbox module never imports app code, so these classes are its contract.

export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

// The tool worked and the file is not there, which is an ordinary answer while
// exploring a repository - typed so it can be told apart from a fault.
export class FileNotFoundError extends Error {
  constructor(readonly path: string) {
    super(
      `File not found in the repository: ${path}. Check the path with Bash (ls, git ls-files).`,
    );
    this.name = "FileNotFoundError";
  }
}

export class PathEscapeError extends Error {
  constructor(readonly path: string) {
    super(`Path escapes the repository: ${path}`);
    this.name = "PathEscapeError";
  }
}

export class GitOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitOperationError";
  }
}

// Refused until the file's read result has reached the model; the message
// doubles as the corrective tool error the model reads.
export class ReadRequiredError extends Error {
  constructor(
    readonly path: string,
    sameTurn = false,
  ) {
    super(
      sameTurn
        ? `${path} was read in this same turn, so its result has not reached you yet: a tool result only arrives in your next message. A read and the change that depends on it cannot share a turn. Read ${path}, then change it in your next turn against what the read returned.`
        : `${path} has not been read in this conversation, so its contents are not in front of you. Read ${path} with the Read tool first, then change it against what the read returned.`,
    );
    this.name = "ReadRequiredError";
  }
}
