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

// Read-before-edit guard: mutating a file never read this session is refused.
// The message doubles as the corrective tool error the model sees.
export class ReadRequiredError extends Error {
  constructor(readonly path: string) {
    super(
      `${path} has not been read this session. Read it with Read before modifying it.`,
    );
    this.name = "ReadRequiredError";
  }
}
