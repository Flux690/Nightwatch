import { randomUUID } from "node:crypto";
import type { NormalizedAlert } from "@nightwarden/shared";
import { dispatcher } from "../dispatcher.js";
import { logger } from "../logger.js";

export interface BatchWindow {
  // Add an alert to the operator-wide batch window. If the window is not yet
  // open, starts the 90s hold timer. Subsequent alerts from any runner join.
  add(alert: NormalizedAlert): void;
  // True if an alert with this (fingerprint, startsAt) is already pending.
  // Used for intra-window dedup: prevents the model seeing the same alert twice.
  has(sourceAlertId: string, firedAt: string): boolean;
  // True while a window is holding alerts, which already has a run coming.
  isOpen(): boolean;
}

export function createBatchWindow(opts: {
  windowMs: number;
  onBatch: (alerts: NormalizedAlert[]) => void;
}): BatchWindow {
  const { windowMs, onBatch } = opts;
  // Single operator-wide pending list: alerts from any runner batch together so
  // the agent can judge shared root cause across servers.
  let pending: NormalizedAlert[] | null = null;

  return {
    add(alert: NormalizedAlert): void {
      if (pending === null) {
        pending = [alert];
        setTimeout(() => {
          const batch = pending!;
          pending = null;
          onBatch(batch);
        }, windowMs);
      } else {
        pending.push(alert);
      }
    },

    has(sourceAlertId: string, firedAt: string): boolean {
      return (
        pending?.some(
          (a) => a.sourceAlertId === sourceAlertId && a.firedAt === firedAt,
        ) ?? false
      );
    },

    isOpen(): boolean {
      return pending !== null;
    },
  };
}

export const batchWindow = createBatchWindow({
  windowMs: 90_000,
  onBatch: (alerts) => {
    if (alerts.length === 0) return;
    // The window is an assembly buffer, not an entity: it elects no member and
    // keeps no identity of its own. What it produces is a session holding them all.
    dispatcher.dispatch({ sessionId: randomUUID(), alerts });
    logger.info(
      {
        alertCount: alerts.length,
        alertIds: alerts.map((a) => a.sourceAlertId),
      },
      "batch window fired",
    );
  },
});
