import type { NormalizedAlert } from "@nightwarden/shared";
import { isDuplicate } from "./dedup.js";
import { checkInvestigationBudget } from "./rate-limit.js";
import { batchWindow } from "./batch-window.js";
import { dispatcher } from "../dispatcher.js";
import { logger } from "../logger.js";

// The one dedup/budget/dispatch path an inbound alert takes.
export function routeAlert(alert: NormalizedAlert): "enqueued" | "skipped" {
  if (isDuplicate(alert)) return "skipped";

  if (batchWindow.has(alert.sourceAlertId, alert.firedAt)) return "skipped";

  const activeSessionId = dispatcher.getActiveAlertSession();
  if (activeSessionId !== null) {
    dispatcher.injectAlert(activeSessionId, alert);
    logger.info(
      { alertId: alert.sourceAlertId, sessionId: activeSessionId },
      "alert injected into active run",
    );
    return "enqueued";
  }

  // Spent here alone: this is the only branch that opens an investigation, and
  // an alert joining an open window rides the run that window will start.
  if (!batchWindow.isOpen() && !checkInvestigationBudget()) {
    logger.warn(
      { alertId: alert.sourceAlertId, type: alert.alertType },
      "investigation budget exhausted for this window",
    );
    return "skipped";
  }

  batchWindow.add(alert);
  logger.info(
    { alertId: alert.sourceAlertId, type: alert.alertType },
    "alert added to batch window",
  );
  return "enqueued";
}
