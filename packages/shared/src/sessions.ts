// A session is the agent's conversation thread (the durable parent); an incident
// is an optional resulting artifact that references it. Sessions live in the
// API's SQLite (state inversion); the API mints the id at trigger time and
// appends per turn in a local transaction.

export type SessionRole = "user" | "assistant";

export interface SessionMeta {
  sessionId: string;
  token: string;
  title: string;
  createdAt: string;
}

export interface SessionMessage {
  sessionId: string;
  seq: number;
  role: SessionRole;
  // Human-readable rendering for the console transcript.
  content: string;
  // Provider-native message structure (content blocks) kept verbatim so a
  // resumed run can rebuild a valid turn - text alone can't reconstruct the
  // thinking/tool_use/tool_result pairing the provider contract requires. Only
  // the matching provider deserializes it, so it is opaque at this layer.
  providerContent?: unknown;
  createdAt: string;
}
