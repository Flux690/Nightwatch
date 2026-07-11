import { randomUUID } from "node:crypto";
import { runInvestigation } from "./agent/loop.js";
import type { RunInvestigationInput } from "./agent/loop.js";
import { getSession } from "./db/sessions.js";
import { logger } from "./logger.js";
import { publishRunFailed } from "./session/stream.js";
import type { NormalizedAlert } from "@nightwatch/shared";

// Alert, chat, and resume all funnel through dispatch(). Alert injection is the
// concurrency control: a new alert while one is running is injected rather than starting a second.
export interface Dispatcher {
  dispatch(input: RunInvestigationInput): void;
  // Derived, not cached. No TTLs — crashed run leaves no marker, so a re-fired alert re-investigates.
  isInvestigating(sourceAlertId: string, firedAt: string): boolean;
  // guards the 409 on POST /sessions/:id/messages
  isSessionRunning(sessionId: string): boolean;
  getActiveAlertSession(): string | null;
  injectAlert(sessionId: string, alert: NormalizedAlert): void;
  drainInbox(sessionId: string): NormalizedAlert[];
  // Aborts the in-flight LLM request for a running session. Returns false if
  // the session isn't currently running.
  stop(sessionId: string): boolean;
}

export interface DispatcherOptions {
  run: (input: RunInvestigationInput) => Promise<void>;
  // resume dispatch never carries input.alert; derive alert identity from the session
  getAlertForSession: (sessionId: string) => NormalizedAlert | null;
}

// (fingerprint, startsAt): re-notifications of a firing alert keep both, so they dedup;
// a twin incident (same labels, different startsAt) is investigated independently.
const KEY_SEP = " ";
function dedupKey(sourceAlertId: string, firedAt: string): string {
  return `${sourceAlertId}${KEY_SEP}${firedAt}`;
}

export function createDispatcher(opts: DispatcherOptions): Dispatcher {
  const { run, getAlertForSession } = opts;

  const active = new Map<string, number>();
  const activeSessionIds = new Set<string>();
  const inbox = new Map<string, NormalizedAlert[]>();
  const controllers = new Map<string, AbortController>();

  // `input.alert` is only present on the original dispatch; a resume carries no alert,
  // so identity falls back to the session's durable originating alert.
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
      alert != null ? dedupKey(alert.sourceAlertId, alert.firedAt) : null;

    retain(key);
    activeSessionIds.add(input.sessionId);
    const controller = new AbortController();
    controllers.set(input.sessionId, controller);

    void run({ ...input, signal: controller.signal })
      .catch((err: unknown) => {
        logger.error(
          { err, sessionId: input.sessionId },
          "investigation failed",
        );
        // Surfaces the crash to the console so the run shows as failed instead of silently
        // going idle; the dispatcher is the single chokepoint that sees every run's terminal rejection.
        publishRunFailed(
          input.sessionId,
          err instanceof Error ? err.message : "Investigation failed.",
        );
      })
      .finally(() => {
        activeSessionIds.delete(input.sessionId);
        controllers.delete(input.sessionId);
        if (alert != null) {
          // Leftovers at run end become one new session; multiple leftovers batch as
          // additionalAlerts, preserving the at-most-one active alert session invariant.
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

    isInvestigating(sourceAlertId: string, firedAt: string): boolean {
      return active.has(dedupKey(sourceAlertId, firedAt));
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

    stop(sessionId: string): boolean {
      const controller = controllers.get(sessionId);
      if (!controller) return false;
      controller.abort();
      return true;
    },
  };
}

export const dispatcher = createDispatcher({
  run: runInvestigation,
  getAlertForSession: (sessionId) =>
    getSession(sessionId)?.originatingAlert ?? null,
});
