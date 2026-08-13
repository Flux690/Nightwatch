import type { NormalizedAlert } from "@nightwarden/shared";
import { isDuplicate } from "./dedup.js";
import { enqueueAlerts, sessionCoveringGroup } from "../db/sessions.js";
import { dispatcher } from "../dispatcher.js";
import { logger } from "../logger.js";
import { publishQueueChanged } from "../session/stream.js";

interface Routed {
  enqueued: number;
  skipped: number;
}

/* The one path an inbound delivery takes. One webhook is one alert group, so the
   group is routed whole rather than alert by alert: splitting it here and
   regrouping on our own clock would replace the user's group_by with a guess.

   An alert joins a live or suspended session only when that session already
   covers its group. That is Alertmanager's decision arriving as a string, not a
   relationship inferred from labels, so the model is told an alert fired and is
   never asked whether it belongs. Everything else waits for its own seat. */
export function routeDelivery(
  groupKey: string,
  firing: NormalizedAlert[],
): Routed {
  const fresh: NormalizedAlert[] = [];
  let skipped = 0;
  for (const alert of firing) {
    if (isDuplicate(alert)) skipped++;
    else fresh.push(alert);
  }
  if (fresh.length === 0) return { enqueued: 0, skipped };

  const sessionId = sessionCoveringGroup(groupKey);
  if (sessionId !== undefined) {
    for (const alert of fresh) {
      dispatcher.injectAlert(sessionId, groupKey, alert);
    }
    logger.info(
      { groupKey, sessionId, alertCount: fresh.length },
      "alerts injected into the run already covering this group",
    );
    return { enqueued: fresh.length, skipped };
  }

  // Durable before any decision about capacity: the sender was answered 200, so
  // a full pool must delay this delivery, never lose it.
  enqueueAlerts(groupKey, fresh);
  logger.info(
    { groupKey, alertCount: fresh.length },
    "alerts queued for investigation",
  );
  publishQueueChanged();
  dispatcher.promoteQueued();
  return { enqueued: fresh.length, skipped };
}
