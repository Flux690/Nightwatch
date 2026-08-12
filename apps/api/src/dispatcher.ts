import { randomUUID } from "node:crypto";
import { buildSessionMeta, runSession } from "./agent/loop.js";
import type { RunSessionInput, RunOutcome } from "./agent/loop.js";
import {
  appendErrorMessage,
  appendSessionAlert,
  createSession,
  dropSessionAlerts,
  getSession,
  isRunning,
  markIdle,
  markRunning,
  sessionExists,
} from "./db/sessions.js";
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
  const inbox = new Map<string, NormalizedAlert[]>();
  const controllers = new Map<string, AbortController>();

  function resolveAlerts(input: RunSessionInput): NormalizedAlert[] {
    return input.alerts ?? getAlertsForSession(input.sessionId);
  }

  function start(input: RunSessionInput): void {
    const alerts = resolveAlerts(input);

    /* The row exists before the session is reachable, the same way the chat
       route writes it before handing out its id. An alert arriving in the gap
       is injected into this session and needs somewhere to land; the run's own
       call is idempotent, so it writes nothing a second time. */
    if (input.alerts !== undefined && input.alerts.length > 0) {
      createSession(
        buildSessionMeta(
          input.sessionId,
          input.alerts[0] ?? null,
          input.userMessage,
        ),
        input.alerts,
        true,
      );
    }

    /* Claimed durably before anything else, so a restart can tell a run that was
       alive from one that concluded, and so a second dispatch cannot start. The
       two ways to lose the claim are told apart: one is a race, the other is a
       caller that dispatched into a session nothing had written. */
    if (!sessionExists(input.sessionId)) {
      logger.error(
        { sessionId: input.sessionId },
        "dispatch refused: no such session, its row must be written first",
      );
      return;
    }
    if (!markRunning(input.sessionId)) {
      logger.warn(
        { sessionId: input.sessionId },
        "dispatch refused: a run already holds this session",
      );
      return;
    }

    liveAlerts.set(
      input.sessionId,
      new Set(alerts.map((a) => dedupKey(a.sourceAlertId, a.firedAt))),
    );
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
            timestamp: new Date().toISOString(),
          };
        }
        publishRunFailed(input.sessionId, row);
      })
      .finally(() => {
        markIdle(input.sessionId);
        controllers.delete(input.sessionId);
        if (alerts.length > 0) {
          // Leftovers at run end become one new session, the whole batch of them,
          // preserving the at-most-one active alert session invariant.
          const leftovers = inbox.get(input.sessionId) ?? [];
          inbox.delete(input.sessionId);
          if (leftovers.length > 0) {
            // Released here and written by the new session, so exactly one
            // session covers each of them.
            dropSessionAlerts(input.sessionId, leftovers);
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

    // Read from the row, not from memory: a run that died with the process is
    // not running, and only the row survives to say so.
    isSessionRunning(sessionId: string): boolean {
      return isRunning(sessionId);
    },

    // liveAlerts holds an entry for exactly as long as a run is in flight, so
    // it is the in-process set of live runs as well as their alert keys.
    getActiveAlertSession(): string | null {
      for (const [sessionId, keys] of liveAlerts) {
        if (keys.size > 0) return sessionId;
      }
      return null;
    },

    // The run now covers this alert too, so a re-fire of it dedups against this
    // session rather than being injected a second time. Durable first: the
    // sender was already answered 200, so a crash here must not lose it.
    injectAlert(sessionId: string, alert: NormalizedAlert): void {
      appendSessionAlert(sessionId, alert);
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
