import { randomUUID } from "node:crypto";
import type { NormalizedAlert } from "@nightwatch/shared";
import { dispatcher } from "../dispatch/dispatcher.js";
import { logger } from "../logger.js";

export interface BatchWindow {
  // Add an alert to the operator-wide batch window. If the window is not yet
  // open, starts the 90s hold timer. Subsequent alerts from any runner join.
  add(alert: NormalizedAlert): void;
  // True if an alert with this runnerId+sourceAlertId is already pending.
  // Used for intra-window dedup: prevents the model seeing the same alert twice.
  has(runnerId: string, sourceAlertId: string): boolean;
}

export function createBatchWindow(opts: {
  windowMs: number;
  onBatch: (alerts: NormalizedAlert[]) => void;
}): BatchWindow {
  const { windowMs, onBatch } = opts;
  // Single operator-wide pending list: alerts from any runner batch together so
  // the agent can judge shared root cause across servers (CONTEXT.md alert pipeline).
  let pending: NormalizedAlert[] | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    add(alert: NormalizedAlert): void {
      if (pending === null) {
        pending = [alert];
        timer = setTimeout(() => {
          const batch = pending!;
          pending = null;
          timer = null;
          onBatch(batch);
        }, windowMs);
      } else {
        pending.push(alert);
      }
    },

    has(runnerId: string, sourceAlertId: string): boolean {
      return (
        pending?.some(
          (a) => a.runnerId === runnerId && a.sourceAlertId === sourceAlertId,
        ) ?? false
      );
    },
  };
}

export const batchWindow = createBatchWindow({
  windowMs: 90_000,
  onBatch: (alerts) => {
    const primary = alerts[0];
    if (!primary) return;
    dispatcher.dispatch({
      sessionId: randomUUID(),
      alert: primary,
      additionalAlerts: alerts.slice(1),
    });
    logger.info(
      { alertCount: alerts.length, primaryId: primary.sourceAlertId },
      "batch window fired",
    );
  },
});
