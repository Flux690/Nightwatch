import type { AgentConfig, NormalizedAlert } from "@nightwatch/shared";
import { serviceIdentityKey } from "@nightwatch/shared";
import { createTitleProvider } from "../llm/factory.js";
import { updateSessionTitle } from "../db/sessions.js";
import { publishSessionTitleUpdated } from "./stream.js";
import { TITLE_SYSTEM_PROMPT } from "../agent/prompts/title.js";
import { logger } from "../logger.js";

const MAX_TITLE_WORDS = 4;
// A batched incident can carry many alerts; bound what reaches the prompt.
const MAX_ALERTS_IN_SOURCE = 10;

export function buildAlertTitleSource(alerts: NormalizedAlert[]): string {
  return alerts
    .slice(0, MAX_ALERTS_IN_SOURCE)
    .map(
      (a) =>
        `[${a.alertType}] ${serviceIdentityKey(a.targetIdentifier)} (${a.severity})`,
    )
    .join("\n");
}

function refine(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/^["'`]+/, "")
    .replace(/["'`.\s]+$/, "");
  return cleaned
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_TITLE_WORDS)
    .join(" ");
}

// Fire-and-forget on its own provider: never touches the investigation's stream,
// so it can't block or corrupt it. Failures are swallowed - the session keeps
// its temporary title.
export async function generateSessionTitle(
  sessionId: string,
  source: string,
  config: AgentConfig,
  apiKey?: string,
): Promise<void> {
  try {
    const trimmed = source.trim();
    if (!trimmed) return;
    const provider = createTitleProvider(TITLE_SYSTEM_PROMPT, config, apiKey);
    provider.start(trimmed);
    const response = await provider.chat([]);
    const title = refine(response.text);
    if (!title) return;
    updateSessionTitle(sessionId, title);
    publishSessionTitleUpdated(sessionId, title);
  } catch (err) {
    logger.warn({ err, sessionId }, "session title generation failed");
  }
}
