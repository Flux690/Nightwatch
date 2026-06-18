import { publishEscalated } from "../session/stream.js";
import { logger } from "../logger.js";
import { appendSyntheticAssistantMessage } from "../db/sessions.js";

// Escalation is session-scoped. This keeps the live control plane on the
// transcript/event model instead of depending on a separate incident record.
export interface IncidentContext {
  containerName: string;
  alertType: string;
  firedAt: string;
}

export function escalate(
  ctx: IncidentContext,
  sessionId: string,
  reason: string,
): void {
  logger.warn(
    { sessionId, reason },
    "investigation escalated to human",
  );

  appendSyntheticAssistantMessage(
    sessionId,
    `Escalated to human: ${reason}`,
  );

  publishEscalated({ sessionId, reason });
}
