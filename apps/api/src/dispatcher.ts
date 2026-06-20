import { randomUUID } from "node:crypto";
import { runInvestigation } from "./agent/loop.js";
import type { RunInvestigationInput } from "./agent/loop.js";
import { getSession } from "./db/sessions.js";
import { logger } from "./logger.js";
import type { NormalizedAlert } from "@nightwatch/shared";

// The single entry to the investigation loop (architecture invariant): alert,
// chat, and resume all funnel through dispatch(). An in-process runner with no
// concurrency cap — every session starts immediately. The injection rule is the
// natural concurrency control for alert sessions: any new alert while one is
// running is injected into it, so there is at most one active alert investigation
// at any time. Chat sessions run freely in parallel.
export interface Dispatcher {
  dispatch(input: RunInvestigationInput): void;
  // Derived dedup source: true while a run for this runnerId + sourceAlertId is
  // active. Keyed by runnerId — the stable per-server identity. No TTLs — a
  // crashed run leaves no marker, so a re-fired alert re-investigates (CONTEXT.md D2/D4).
  isInvestigating(runnerId: string, sourceAlertId: string): boolean;
  // True while a run for this sessionId is active. Used for the 409 guard on
  // POST /sessions/:id/messages.
  isSessionRunning(sessionId: string): boolean;
  // Returns the sessionId of the currently active alert investigation, or null
  // if none is running. Alert injection is operator-wide: a new alert arriving
  // while any alert session is running goes into that session regardless of which
  // runner sent it.
  getActiveAlertSession(): string | null;
  // Push an alert into the inbox of an actively running session. The loop drains
  // it at the next tool boundary.
  injectAlert(sessionId: string, alert: NormalizedAlert): void;
  // Pop and return all inbox alerts for the session. Called by the loop at each
  // tool boundary. Returns empty array if the session has no inbox.
  drainInbox(sessionId: string): NormalizedAlert[];
}

export interface DispatcherOptions {
  run: (input: RunInvestigationInput) => Promise<void>;
  // The session's durable originating alert (null for chat sessions). A resume
  // dispatch never carries `input.alert` (see human-input/service.ts), so alert
  // identity must be derivable from the session itself, not just the live input.
  getAlertForSession: (sessionId: string) => NormalizedAlert | null;
}

// A NUL separator cannot appear in a runnerId or sourceAlertId
// (fingerprint/string from webhook payload), so this maps to exactly one key.
const KEY_SEP = " ";
function dedupKey(runnerId: string, sourceAlertId: string): string {
  return `${runnerId}${KEY_SEP}${sourceAlertId}`;
}

export function createDispatcher(opts: DispatcherOptions): Dispatcher {
  const { run, getAlertForSession } = opts;

  // Multiset: a dedup key is present while any active run carries it.
  const active = new Map<string, number>();
  const activeSessionIds = new Set<string>();
  // Per-session inbox for mid-run injected alerts. Drained at tool boundaries.
  const inbox = new Map<string, NormalizedAlert[]>();

  // D4: derive, don't cache. `input.alert` is only present on the original
  // dispatch - a resume carries no alert, so identity falls back to the
  // session's durable originating alert.
  function resolveAlert(input: RunInvestigationInput): NormalizedAlert | null {
    return input.alert ?? getAlertForSession(input.sessionId);
  }

  function retain(key: string | null): void {
    if (key === null) return;
    active.set(key, (active.get(key) ?? 0) + 1);
  }

  function release(key: string | null): void {
    if (key === null) return;
    const next = (active.get(key) ?? 0) - 1;
    if (next <= 0) active.delete(key);
    else active.set(key, next);
  }

  function start(input: RunInvestigationInput): void {
    const alert = resolveAlert(input);
    const key =
      alert != null ? dedupKey(alert.runnerId, alert.sourceAlertId) : null;

    retain(key);
    activeSessionIds.add(input.sessionId);

    void run(input)
      .catch((err: unknown) => {
        logger.error(
          { err, sessionId: input.sessionId },
          "investigation failed",
        );
      })
      .finally(() => {
        activeSessionIds.delete(input.sessionId);
        if (alert != null) {
          // Dispatch inbox leftovers as one new session (CONTEXT.md alert pipeline:
          // "inbox leftovers at run end become new sessions"). Multiple leftovers
          // batch together as additionalAlerts — identical to the batch-window
          // path — so the at-most-one active alert session invariant holds.
          const leftovers = inbox.get(input.sessionId) ?? [];
          inbox.delete(input.sessionId);
          if (leftovers.length > 0) {
            start({
              sessionId: randomUUID(),
              alert: leftovers[0]!,
              additionalAlerts: leftovers.slice(1),
            });
          }
        }
        release(key);
      });
  }

  return {
    dispatch: start,

    isInvestigating(runnerId: string, sourceAlertId: string): boolean {
      return active.has(dedupKey(runnerId, sourceAlertId));
    },

    isSessionRunning(sessionId: string): boolean {
      return activeSessionIds.has(sessionId);
    },

    getActiveAlertSession(): string | null {
      for (const sessionId of activeSessionIds) {
        if (getAlertForSession(sessionId) != null) return sessionId;
      }
      return null;
    },

    injectAlert(sessionId: string, alert: NormalizedAlert): void {
      const arr = inbox.get(sessionId) ?? [];
      arr.push(alert);
      inbox.set(sessionId, arr);
    },

    drainInbox(sessionId: string): NormalizedAlert[] {
      const arr = inbox.get(sessionId) ?? [];
      inbox.delete(sessionId);
      return arr;
    },
  };
}

export const dispatcher = createDispatcher({
  run: runInvestigation,
  getAlertForSession: (sessionId) =>
    getSession(sessionId)?.originatingAlert ?? null,
});
