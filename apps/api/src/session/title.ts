import type { ResolvedLLMConfig, NormalizedAlert } from "@nightwarden/shared";
import { createTitleProvider } from "../llm/factory.js";
import { updateSessionTitle } from "../db/sessions.js";
import { publishSessionTitleUpdated } from "./stream.js";
import { TITLE_SYSTEM_PROMPT } from "../agent/prompts/title.js";
import { logger } from "../logger.js";

const MAX_TITLE_WORDS = 4;
// A batched incident can carry many alerts; bound what reaches the prompt.
const MAX_ALERTS_IN_SOURCE = 10;

// Labels rather than a resolved key: the title model gets more to work with from
// what the alert actually said than from a key assembled after the fact.
export function buildAlertTitleSource(alerts: NormalizedAlert[]): string {
  return alerts
    .slice(0, MAX_ALERTS_IN_SOURCE)
    .map((a) => {
      const labels = Object.entries(a.labels)
        .filter(([key]) => key !== "alertname" && key !== "severity")
        .map(([key, value]) => `${key}=${value}`)
        .join(" ");
      return `[${a.alertType}] ${labels} (${a.severity})`.replace(/\s+/g, " ");
    })
    .join("\n");
}

function refine(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/^["'`]+/, "")
    .replace(/["'`,;:.\s]+$/, "");
  return (
    cleaned
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, MAX_TITLE_WORDS)
      .join(" ")
      // The word slice can expose punctuation that was mid-string before it.
      .replace(/["'`,;:.\s]+$/, "")
  );
}

// Fire-and-forget on its own provider: never touches the investigation's stream,
// so it can't block or corrupt it. Failures are swallowed - the session keeps
// its temporary title.
export async function generateSessionTitle(
  sessionId: string,
  source: string,
  config: ResolvedLLMConfig,
  apiKey?: string,
): Promise<void> {
  try {
    const trimmed = source.trim();
    if (!trimmed) return;
    // reasoning "off": a 4-word label has nothing to think about. The 1024
    // window is a seatbelt for models that reason regardless - reasoning
    // shares the output budget, and a starved budget returns empty text.
    const titleConfig: ResolvedLLMConfig = {
      ...config,
      maxOutputTokens: 1024,
    };
    const provider = createTitleProvider(
      TITLE_SYSTEM_PROMPT,
      titleConfig,
      apiKey,
      { reasoning: "off" },
    );
    // Framed as quoted material inside an instruction: a bare conversational
    // message in the user slot pulls the model into answering it instead.
    provider.start(
      `Title this session. Its opening content:\n<content>\n${trimmed}\n</content>`,
    );
    const response = await provider.chat([]);
    const title = refine(response.text);
    if (!title) {
      logger.warn(
        { sessionId, model: config.model, stopReason: response.stopReason },
        "session title unusable, keeping the temporary title",
      );
      return;
    }
    updateSessionTitle(sessionId, title);
    publishSessionTitleUpdated(sessionId, title);
  } catch (err) {
    logger.warn({ err, sessionId }, "session title generation failed");
  }
}
