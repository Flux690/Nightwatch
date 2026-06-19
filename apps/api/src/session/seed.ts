import { getSessionMessages } from "../db/sessions.js";
import type { ProviderMessage } from "../llm/types.js";

export function buildSeed(sessionId: string): ProviderMessage[] {
  return getSessionMessages(sessionId).map((m) => ({
    role: m.role,
    content: m.content,
    providerContent: m.providerContent,
  }));
}
