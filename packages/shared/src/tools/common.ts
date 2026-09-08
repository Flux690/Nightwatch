// Vocabulary both platforms share, so no type has to branch on platform.
// Anything describing a container or workload lives in its own file.

// One line and when the engine says it was written, so a log can be placed
// against the alert. Empty ts where the engine stamped none.
export interface LogLine {
  ts: string;
  line: string;
}

// Propagated verbatim, so "not running" is a finding the agent reasons about
// rather than an exception. Each resolver builds its own.
export interface NotFoundResult {
  found: false;
  reason: string;
}

// One server's answer inside a fan-out.
export interface ServerScopedResult<T> {
  server: string;
  result: T;
}

// A server-routed command's result, always enveloped even for a single server, so
// the model and the frontend each have exactly one shape to read.
export interface FleetResult<T> {
  byServer: Array<ServerScopedResult<T>>;
}
