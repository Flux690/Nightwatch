import { randomUUID } from "node:crypto";
import { buildSessionMeta, runSession } from "./agent/loop.js";
import type { RunSessionInput, RunOutcome } from "./agent/loop.js";
import {
  appendErrorMessage,
  appendSessionAlert,
  claimRun,
  clearRunFailure,
  recordRunFailure,
  getSession,
  isRunning,
  oldestQueuedGroup,
  openSessionForGroup,
  releaseRun,
  sessionExists,
} from "./db/sessions.js";
import { hasSeat } from "./run-pool.js";
import { describeLLMError, isTransientLLMError } from "./llm/failures.js";
import { logger } from "./logger.js";
import {
  publishQueueChanged,
  publishRunFailed,
  publishRunFinished,
  publishRunStopped,
} from "./session/stream.js";
import type { NormalizedAlert, TranscriptRow } from "@nightwarden/shared";

// Alert, chat, and resume all funnel through dispatch(). Concurrency is the run
// pool; what an alert joins is Alertmanager's group key, never our timing.
interface Dispatcher {
  // Answers whether the run started. False means the session already holds a
  // run, which is a race the caller reports rather than a fault.
  dispatch(input: RunSessionInput): boolean;
  // Starts as many waiting alert groups as there are free seats. Called when a
  // seat frees, when a delivery is queued, and once at boot.
  promoteQueued(): void;
  // guards the 409 on POST /sessions/:id/messages
  isSessionRunning(sessionId: string): boolean;
  injectAlert(
    sessionId: string,
    groupKey: string,
    alert: NormalizedAlert,
    droppedAlerts?: number,
  ): void;
  drainInbox(sessionId: string): NormalizedAlert[];
  // Aborts the in-flight LLM request for a running session. Returns false if
  // the session isn't currently running.
  stop(sessionId: string): boolean;
}

interface DispatcherOptions {
  run: (input: RunSessionInput) => Promise<RunOutcome>;
}

export function createDispatcher(opts: DispatcherOptions): Dispatcher {
  const { run } = opts;

  const inbox = new Map<string, NormalizedAlert[]>();
  const controllers = new Map<string, AbortController>();

  function start(input: RunSessionInput): boolean {
    /* Claimed durably before anything else, so a restart can tell a run that was
       alive from one that concluded, and so a second dispatch cannot start. The
       two ways to lose the claim are told apart: one is a race, the other is a
       caller that dispatched into a session nothing had written. */
    if (!sessionExists(input.sessionId)) {
      logger.error(
        { sessionId: input.sessionId },
        "dispatch refused: no such session, its row must be written first",
      );
      return false;
    }
    if (!claimRun(input.sessionId)) {
      logger.warn(
        { sessionId: input.sessionId },
        "dispatch refused: a run already holds this session",
      );
      return false;
    }

    const controller = new AbortController();
    controllers.set(input.sessionId, controller);

    void run({ ...input, signal: controller.signal })
      .then((outcome) => {
        // A run that reached an ending, however it ended, is not a failure any
        // more - so it stops carrying one and gets its full three attempts back.
        clearRunFailure(input.sessionId);
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
        /* Classified here or not at all: only the error object can say whether
           trying again could ever work, and it does not survive into the
           transcript row written below. */
        recordRunFailure(
          input.sessionId,
          isTransientLLMError(err) ? "transient" : "permanent",
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
        // Conditional on 'running', so a run that suspended keeps the seat it is
        // waiting on a human with.
        releaseRun(input.sessionId);
        controllers.delete(input.sessionId);
        inbox.delete(input.sessionId);
        promoteQueued();
      });
    return true;
  }

  /* A seat freed, so the alerts that were waiting for one become sessions. Runs
     here rather than in the pool because starting a run is this module's job and
     the pool only counts seats - it never learns how to dispatch. */
  function promoteQueued(): void {
    while (hasSeat(true)) {
      const group = oldestQueuedGroup();
      if (group === undefined) return;
      const sessionId = randomUUID();
      openSessionForGroup(
        buildSessionMeta(sessionId, group.alerts[0] ?? null, undefined),
        group.groupKey,
      );
      logger.info(
        {
          sessionId,
          groupKey: group.groupKey,
          alertCount: group.alerts.length,
        },
        "queued alert group promoted to an investigation",
      );
      publishQueueChanged();
      // A promotion that cannot start would spin: the group is assigned, so the
      // next pass would find a different head and never reach this one again.
      if (!start({ sessionId, alerts: group.alerts })) return;
    }
  }

  return {
    dispatch: start,
    promoteQueued,

    // Read from the row, not from memory: a run that died with the process is
    // not running, and only the row survives to say so.
    isSessionRunning(sessionId: string): boolean {
      return isRunning(sessionId);
    },

    /* The run now covers this alert too, so a repeat of it dedups against this
       session rather than being injected a second time. Durable first: the
       sender was already answered 200, so a crash here must not lose it. */
    injectAlert(
      sessionId: string,
      groupKey: string,
      alert: NormalizedAlert,
      droppedAlerts = 0,
    ): void {
      appendSessionAlert(sessionId, groupKey, alert, droppedAlerts);
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

export const dispatcher = createDispatcher({ run: runSession });
