import { randomUUID } from "node:crypto";
import type { NormalizedAlert } from "@nightwatch/shared";
import { dispatcher } from "../dispatch/dispatcher.js";
import { logger } from "../logger.js";

export interface BatchWindow {
  // Add an alert to the window for its token. If this is the first alert for
  // the token, starts the 90s hold timer. Subsequent same-token alerts join.
  add(alert: NormalizedAlert): void;
  // True if an alert with this exact sourceAlertId is already pending for
  // this token. Used for intra-window dedup.
  has(tokenId: string, sourceAlertId: string): boolean;
}

export function createBatchWindow(opts: {
  windowMs: number;
  onBatch: (tokenId: string, alerts: NormalizedAlert[]) => void;
}): BatchWindow {
  const { windowMs, onBatch } = opts;
  const pending = new Map<string, NormalizedAlert[]>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  return {
    add(alert: NormalizedAlert): void {
      const existing = pending.get(alert.token);
      if (existing) {
        existing.push(alert);
        return;
      }
      pending.set(alert.token, [alert]);
      const timer = setTimeout(() => {
        const alerts = pending.get(alert.token) ?? [];
        pending.delete(alert.token);
        timers.delete(alert.token);
        onBatch(alert.token, alerts);
      }, windowMs);
      timers.set(alert.token, timer);
    },

    has(tokenId: string, sourceAlertId: string): boolean {
      return (
        pending.get(tokenId)?.some((a) => a.sourceAlertId === sourceAlertId) ??
        false
      );
    },
  };
}

export const batchWindow = createBatchWindow({
  windowMs: 90_000,
  onBatch: (tokenId, alerts) => {
    const primary = alerts[0];
    if (!primary) return;
    const accepted = dispatcher.dispatch({
      sessionId: randomUUID(),
      token: tokenId,
      trigger: "alert",
      alert: primary,
      additionalAlerts: alerts.slice(1),
    });
    if (!accepted) {
      logger.warn(
        { tokenId, alertCount: alerts.length },
        "batch window fired but dispatch queue full, batch dropped (alerts will re-fire)",
      );
    }
  },
});
