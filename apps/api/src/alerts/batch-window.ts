import { randomUUID } from "node:crypto";
import type { NormalizedAlert } from "@nightwarden/shared";
import { dispatcher } from "../dispatcher.js";
import { logger } from "../logger.js";

interface BatchWindow {
  // Add an alert to the operator-wide batch window. If the window is not yet
  // open, starts the 90s hold timer. Subsequent alerts from any runner join.
  add(alert: NormalizedAlert): void;
  // True if an alert with this (fingerprint, startsAt) is already pending.
  // Used for intra-window dedup: prevents the model seeing the same alert twice.
  has(sourceAlertId: string, firedAt: string): boolean;
  // True while a window is holding alerts, which already has a run coming.
  isOpen(): boolean;
  /* Fires whatever is held, now. Called on shutdown: everything in here was
     answered 200, and dispatching writes the session and its alert rows before
     the run is reachable, so they are durable even though the run that starts
     dies moments later with the process. Boot recovery picks that session up. */
  flush(): void;
}

function createBatchWindow(opts: {
  windowMs: number;
  onBatch: (alerts: NormalizedAlert[]) => void;
}): BatchWindow {
  const { windowMs, onBatch } = opts;
  // Single operator-wide pending list: alerts from any runner batch together so
  // the agent can judge shared root cause across servers.
  let pending: NormalizedAlert[] | null = null;
  let timer: NodeJS.Timeout | null = null;

  function fire(): void {
    const batch = pending ?? [];
    pending = null;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (batch.length > 0) onBatch(batch);
  }

  return {
    add(alert: NormalizedAlert): void {
      if (pending === null) {
        pending = [alert];
        timer = setTimeout(fire, windowMs);
        // A batch waiting to fire is not a reason to keep the process alive:
        // the server holds the loop open, and shutdown flushes this explicitly.
        timer.unref();
      } else {
        pending.push(alert);
      }
    },

    flush: fire,

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
