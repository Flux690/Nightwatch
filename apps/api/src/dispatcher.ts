import { randomUUID } from "node:crypto";
import { runSession } from "./agent/loop.js";
import type { RunSessionInput, RunOutcome } from "./agent/loop.js";
import { appendErrorMessage, getSession } from "./db/sessions.js";
import { describeLLMError } from "./llm/failures.js";
import { logger } from "./logger.js";
import {
  publishRunFailed,
  publishRunFinished,
  publishRunStopped,
} from "./session/stream.js";
import type { NormalizedAlert, TranscriptRow } from "@nightwarden/shared";

// Alert, chat, and resume all funnel through dispatch(). Alert injection is the
// concurrency control: a new alert while one is running is injected rather than starting a second.
interface Dispatcher {
  dispatch(input: RunSessionInput): void;
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

interface DispatcherOptions {
  run: (input: RunSessionInput) => Promise<RunOutcome>;
  // A resume dispatch carries no alerts, so a live run recovers the set it is
  // covering from the session's durable record.
  getAlertsForSession: (sessionId: string) => NormalizedAlert[];
}

// (fingerprint, startsAt): re-notifications of a firing alert keep both, so they dedup;
// a twin incident (same labels, different startsAt) is investigated independently.
const KEY_SEP = " ";
function dedupKey(sourceAlertId: string, firedAt: string): string {
  return `${sourceAlertId}${KEY_SEP}${firedAt}`;
}

export function createDispatcher(opts: DispatcherOptions): Dispatcher {
  const { run, getAlertsForSession } = opts;

  // Every alert each live run is covering, not one elected from the batch: a
  // session investigating ten alerts must dedup a re-fire of any of the ten.
  // Keyed by session, so a run's set leaves with it and nothing is counted.
  const liveAlerts = new Map<string, Set<string>>();
  const activeSessionIds = new Set<string>();
  const inbox = new Map<string, NormalizedAlert[]>();
  const controllers = new Map<string, AbortController>();

  function resolveAlerts(input: RunSessionInput): NormalizedAlert[] {
    return input.alerts ?? getAlertsForSession(input.sessionId);
  }

  function start(input: RunSessionInput): void {
    const alerts = resolveAlerts(input);

    liveAlerts.set(
      input.sessionId,
      new Set(alerts.map((a) => dedupKey(a.sourceAlertId, a.firedAt))),
    );
    activeSessionIds.add(input.sessionId);
    const controller = new AbortController();
    controllers.set(input.sessionId, controller);

    void run({ ...input, signal: controller.signal })
      .then((outcome) => {
        // Single lifecycle owner: exactly one terminal event per run. Completed and
        // stopped runs need theirs here; suspended runs already ended via the loop's
        // interrupt event, and failed runs terminate in the catch below.
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
        let row: TranscriptRow;
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
            kind: "error",
            content: text,
            parts: [],
            createdAt: new Date().toISOString(),
          };
        }
        publishRunFailed(input.sessionId, row);
      })
      .finally(() => {
        activeSessionIds.delete(input.sessionId);
        controllers.delete(input.sessionId);
        if (alerts.length > 0) {
          // Leftovers at run end become one new session, the whole batch of them,
          // preserving the at-most-one active alert session invariant.
          const leftovers = inbox.get(input.sessionId) ?? [];
          inbox.delete(input.sessionId);
          if (leftovers.length > 0) {
            start({ sessionId: randomUUID(), alerts: leftovers });
          }
        }
        liveAlerts.delete(input.sessionId);
      });
  }

  return {
    dispatch: start,

    isInvestigating(sourceAlertId: string, firedAt: string): boolean {
      const key = dedupKey(sourceAlertId, firedAt);
      for (const keys of liveAlerts.values()) if (keys.has(key)) return true;
      return false;
    },

    isSessionRunning(sessionId: string): boolean {
      return activeSessionIds.has(sessionId);
    },

    getActiveAlertSession(): string | null {
      for (const sessionId of activeSessionIds) {
        if ((liveAlerts.get(sessionId)?.size ?? 0) > 0) return sessionId;
      }
      return null;
    },

    // The run now covers this alert too, so a re-fire of it dedups against this
    // session rather than being injected a second time.
    injectAlert(sessionId: string, alert: NormalizedAlert): void {
      const arr = inbox.get(sessionId) ?? [];
      arr.push(alert);
      inbox.set(sessionId, arr);
      liveAlerts
        .get(sessionId)
        ?.add(dedupKey(alert.sourceAlertId, alert.firedAt));
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
  run: runSession,
  getAlertsForSession: (sessionId) =>
    (getSession(sessionId)?.alerts ?? []).map((entry) => entry.alert),
});
