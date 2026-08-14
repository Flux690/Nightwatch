import type { DeliveryContext, NormalizedAlert } from "@nightwarden/shared";
import { isDuplicate } from "./dedup.js";
import { enqueueAlerts, sessionCoveringGroup } from "../db/sessions.js";
import { dispatcher } from "../dispatcher.js";
import { logger } from "../logger.js";
import { publishQueueChanged } from "../session/stream.js";

interface Routed {
  enqueued: number;
  skipped: number;
}

/* One webhook is one group, routed whole: splitting it and regrouping on our own
   clock would replace the user's group_by with a guess. An alert joins a live or
   suspended session only when that session already covers its group. */
export function routeDelivery(
  groupKey: string,
  firing: NormalizedAlert[],
  // Required, not defaulted: a caller that forgets it silently tells every
  // investigation the group arrived whole and unexplained.
  delivery: DeliveryContext,
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
      dispatcher.injectAlert(sessionId, groupKey, alert, delivery);
    }
    logger.info(
      { groupKey, sessionId, alertCount: fresh.length },
      "alerts injected into the run already covering this group",
    );
    return { enqueued: fresh.length, skipped };
  }

  // Durable before any decision about capacity: the sender was answered 200, so
  // a full pool must delay this delivery, never lose it.
  enqueueAlerts(groupKey, fresh, delivery);
  logger.info(
    { groupKey, alertCount: fresh.length },
    "alerts queued for investigation",
  );
  publishQueueChanged();
  dispatcher.promoteQueued();
  return { enqueued: fresh.length, skipped };
}
