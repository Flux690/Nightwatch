// Typed failures the host maps to corrective tool errors or HTTP statuses.
// The sandbox module never imports app code, so these classes are its contract.

export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
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
