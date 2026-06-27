// A session is the agent's conversation thread (the durable parent); an incident is an
// optional artifact referencing it. Sessions live in the API's SQLite, id minted at
// trigger time, appended per turn.

export type SessionRole = "user" | "assistant";

export interface SessionMeta {
  sessionId: string;
  title: string;
  createdAt: string;
}

export interface SessionMessage {
  sessionId: string;
  seq: number;
  role: SessionRole;
  // Human-readable rendering for the console transcript.
  content: string;
  // Provider-native message kept verbatim so a resumed run rebuilds a valid turn - text
  // alone can't restore the thinking/tool_use/tool_result pairing. Opaque here; only the
  // matching provider deserializes it.
  providerContent?: unknown;
  createdAt: string;
}
