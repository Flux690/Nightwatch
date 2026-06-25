import type { NormalizedAlert } from "@nightwatch/shared";
import { isDuplicate } from "./dedup.js";
import { checkRateLimit } from "./rate-limit.js";
import { batchWindow } from "./batch-window.js";
import { dispatcher } from "../dispatcher.js";
import { logger } from "../logger.js";

// Shared by /alerts/ingest and the verify-test-alert endpoint so both flows
// go through one dedup/rate-limit/dispatch path.
export function routeAlert(alert: NormalizedAlert): "enqueued" | "skipped" {
  if (isDuplicate(alert)) return "skipped";

  if (batchWindow.has(alert.runnerId, alert.sourceAlertId)) return "skipped";

  if (!checkRateLimit(alert.runnerId, alert.severity)) {
    logger.warn({ alertId: alert.sourceAlertId }, "rate limited");
    return "skipped";
  }

  const activeSessionId = dispatcher.getActiveAlertSession();
  if (activeSessionId !== null) {
    dispatcher.injectAlert(activeSessionId, alert);
    logger.info(
      { alertId: alert.sourceAlertId, sessionId: activeSessionId },
      "alert injected into active run",
    );
  } else {
    batchWindow.add(alert);
    logger.info(
      { alertId: alert.sourceAlertId, type: alert.alertType },
      "alert added to batch window",
    );
  }

  return "enqueued";
}
