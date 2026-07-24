import { randomUUID } from "node:crypto";
import { runInvestigation } from "./agent/loop.js";
import type { RunInvestigationInput, RunOutcome } from "./agent/loop.js";
import { appendErrorMessage, getSession } from "./db/sessions.js";
import { describeLLMError } from "./llm/failures.js";
import { logger } from "./logger.js";
import {
  publishRunFailed,
  publishRunFinished,
  publishRunStopped,
} from "./session/stream.js";
import type { NormalizedAlert, SessionMessage } from "@nightwarden/shared";

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
  run: (input: RunInvestigationInput) => Promise<RunOutcome>;
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
      .then((outcome) => {
        // Single lifecycle owner: exactly one terminal event per run. A completed
        // run has none yet (the loop only streamed messages); a stopped run needs
        // its terminal here too. Suspended runs already ended via the interrupt
        // event the loop emitted; failed runs terminate in the catch below.
        if (outcome === "completed") publishRunFinished(input.sessionId);
        else if (outcome === "stopped") publishRunStopped(input.sessionId);
      })
      .catch((err: unknown) => {
        logger.error(
          { err, sessionId: input.sessionId },
          "investigation failed",
        );
        // The failure becomes a durable transcript row rendered like any other
        // message; a synthetic row still unsticks the console if persist fails.
        const text = describeLLMError(err);
        let row: SessionMessage;
        try {
          row = appendErrorMessage(input.sessionId, text);
        } catch (persistErr: unknown) {
          logger.warn(
            { err: persistErr, sessionId: input.sessionId },
            "run failure row not persisted",
          );
          row = {
            sessionId: input.sessionId,
            seq: 0,
            role: "error",
            content: text,
            createdAt: new Date().toISOString(),
          };
        }
        publishRunFailed(input.sessionId, row);
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
