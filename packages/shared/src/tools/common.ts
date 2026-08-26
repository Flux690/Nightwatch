// Vocabulary both platforms share, so no type has to branch on platform.
// Anything describing a container or workload lives in its own file.
export type RiskLevel = "low" | "medium" | "high";

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
// the model and the console each have exactly one shape to read.
export interface FleetResult<T> {
  byServer: Array<ServerScopedResult<T>>;
  // Set only when the fan-out cap dropped servers, because a reading that covers
  // less than the fleet has to say so rather than read as the whole of it.
  serversOmitted?: number;
}
