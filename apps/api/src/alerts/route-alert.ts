import type { NormalizedAlert } from "@nightwarden/shared";
import type { DeliveryContext } from "./delivery.js";
import { isDuplicate } from "./dedup.js";
import {
  enqueueAlerts,
  sessionCoveringGroup,
} from "../session/alerts-store.js";
import { dispatcher } from "../dispatcher.js";
import { logger } from "../logger.js";
import { publishQueueChanged } from "../session/stream.js";

interface Routed {
  enqueued: number;
  skipped: number;
}

// One webhook is one group, routed whole: regrouping on our own clock would
// replace the user's group_by with a guess.
export async function routeDelivery(
  groupKey: string,
  firing: NormalizedAlert[],
  // Required, not defaulted: a caller that forgets it silently tells every
  // investigation the group arrived whole and unexplained.
  delivery: DeliveryContext,
): Promise<Routed> {
  const fresh: NormalizedAlert[] = [];
  let skipped = 0;
  for (const alert of firing) {
    if (await isDuplicate(alert)) skipped++;
    else fresh.push(alert);
  }
  // Repeats are ordinary - Alertmanager re-sends on repeat_interval - but a
  // silent drop is what makes a reused fingerprint invisible in a test.
  if (skipped > 0)
    logger.info({ groupKey, skipped }, "duplicate alerts dropped");
  if (fresh.length === 0) return { enqueued: 0, skipped };

  const sessionId = await sessionCoveringGroup(groupKey);
  if (sessionId !== undefined) {
    for (const alert of fresh) {
      await dispatcher.injectAlert(sessionId, groupKey, alert, delivery);
    }
    logger.info(
      { groupKey, sessionId, alertCount: fresh.length },
      "alerts injected into the run already covering this group",
    );
    return { enqueued: fresh.length, skipped };
  }

  // Durable before any decision about capacity: the sender was answered 200, so
  // a full pool must delay this delivery, never lose it.
  await enqueueAlerts(groupKey, fresh, delivery);
  logger.info(
    { groupKey, alertCount: fresh.length },
    "alerts queued for investigation",
  );
  await publishQueueChanged();
  await dispatcher.promoteQueued();
  return { enqueued: fresh.length, skipped };
}
