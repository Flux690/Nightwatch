import { randomUUID } from "node:crypto";
import { buildSessionMeta, runSession } from "./agent/loop/run-session.js";
import type { RunSessionInput, RunOutcome } from "./agent/loop/run-session.js";
import {
  appendSessionAlert,
  oldestQueuedGroup,
} from "./session/alerts-store.js";
import {
  claimRun,
  clearRunFailure,
  isRunning,
  recordRunFailure,
  releaseRun,
} from "./session/status-store.js";
import { openSessionForGroup, sessionExists } from "./session/store.js";
import { appendErrorMessage } from "./session/transcript-store.js";
import { markStopped } from "./session/status-store.js";
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
import type { DeliveryContext } from "./alerts/delivery.js";

// Alert, chat, and resume all funnel through dispatch(). Concurrency is the run
// pool; what an alert joins is Alertmanager's group key, never our timing.
interface Dispatcher {
  // Answers whether the run started. False means the session already holds a
  // run, which is a race the caller reports rather than a fault.
  dispatch(input: RunSessionInput): Promise<boolean>;
  // Starts as many waiting alert groups as there are free seats. Called when a
  // seat frees, when a delivery is queued, and once at boot.
  promoteQueued(): void;
  // guards the 409 on POST /sessions/:id/messages
  isSessionRunning(sessionId: string): Promise<boolean>;
  injectAlert(
    sessionId: string,
    groupKey: string,
    alert: NormalizedAlert,
    delivery: DeliveryContext,
  ): void;
  drainInbox(sessionId: string): NormalizedAlert[];
  // Aborts the in-flight LLM request for a running session. Returns false if
  // the session isn't currently running.
  stop(sessionId: string): boolean;
}

interface DispatcherOptions {
  run: (input: RunSessionInput) => Promise<RunOutcome>;
}

// How a run ended, named once. Consumers subscribe to this rather than working
// out which promise arm they are in - .finally fires on a suspend as well.
type RunEnding = RunOutcome | "failed";

export function createDispatcher(opts: DispatcherOptions): Dispatcher {
  const { run } = opts;

  const inbox = new Map<string, NormalizedAlert[]>();
  const controllers = new Map<string, AbortController>();

  /* Classified here or not at all: only the error object can say whether trying
     again could ever work, and it does not survive into the transcript row. */
  async function recordFailure(sessionId: string, err: unknown): Promise<void> {
    logger.error({ err, sessionId }, "investigation failed");
    await recordRunFailure(
      sessionId,
      isTransientLLMError(err) ? "transient" : "permanent",
    );
    // The failure becomes a durable transcript row rendered like any other
    // message; a synthetic row still unsticks the frontend if persist fails.
    const text = describeLLMError(err);
    let row: TranscriptRow;
    try {
      row = await appendErrorMessage(sessionId, text);
    } catch (persistErr: unknown) {
      logger.warn(
        { err: persistErr, sessionId },
        "run failure row not persisted",
      );
      row = {
        sessionId,
        seq: 0,
        kind: "error",
        content: text,
        parts: [],
        timestamp: new Date().toISOString(),
      };
    }
    publishRunFailed(sessionId, row);
  }

  // Every run ends here, named. Exactly one terminal event each: a suspended run
  // already published its interrupt, and a failed one its row above.
  async function onRunEnded(
    sessionId: string,
    ending: RunEnding,
  ): Promise<void> {
    if (ending === "failed") return;
    // A run that reached an ending, however it ended, is not a failure any more,
    // so it stops carrying one and gets its full three attempts back.
    await clearRunFailure(sessionId);
    if (ending === "completed") publishRunFinished(sessionId);
    else if (ending === "stopped") {
      await markStopped(sessionId);
      publishRunStopped(sessionId);
    }
  }

  function drainInbox(sessionId: string): NormalizedAlert[] {
    const arr = inbox.get(sessionId) ?? [];
    inbox.delete(sessionId);
    return arr;
  }

  async function start(input: RunSessionInput): Promise<boolean> {
    // Claimed durably first, so a restart can tell a run that was alive from one
    // that concluded, and a second dispatch cannot start.
    if (!(await sessionExists(input.sessionId))) {
      logger.error(
        { sessionId: input.sessionId },
        "dispatch refused: no such session, its row must be written first",
      );
      return false;
    }
    if (!(await claimRun(input.sessionId))) {
      logger.warn(
        { sessionId: input.sessionId },
        "dispatch refused: a run already holds this session",
      );
      return false;
    }

    const controller = new AbortController();
    controllers.set(input.sessionId, controller);

    void run({ ...input, signal: controller.signal, drainInbox })
      .then(async (outcome) => await onRunEnded(input.sessionId, outcome))
      .catch(async (err: unknown) => {
        await recordFailure(input.sessionId, err);
        await onRunEnded(input.sessionId, "failed");
      })
      .finally(async () => {
        // Conditional on 'running', so a run that suspended keeps the seat it is
        // waiting on a human with.
        await releaseRun(input.sessionId);
        controllers.delete(input.sessionId);
        inbox.delete(input.sessionId);
        await promoteQueued();
      });
    return true;
  }

  // Here rather than in the pool, because starting a run is this module's job
  // and the pool only counts seats.
  async function promoteQueued(): Promise<void> {
    while (await hasSeat(true)) {
      const group = await oldestQueuedGroup();
      if (group === undefined) return;
      const sessionId = randomUUID();
      await openSessionForGroup(
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
      await publishQueueChanged();
      // A promotion that cannot start would spin: the group is assigned, so the
      // next pass would find a different head and never reach this one again.
      if (!(await start({ sessionId, alerts: group.alerts }))) return;
    }
  }

  return {
    dispatch: start,
    promoteQueued,

    // Read from the row, not from memory: a run that died with the process is
    // not running, and only the row survives to say so.
    async isSessionRunning(sessionId: string): Promise<boolean> {
      return await isRunning(sessionId);
    },

    // Durable first: the sender was already answered 200, so a crash here must
    // not lose the alert.
    async injectAlert(
      sessionId: string,
      groupKey: string,
      alert: NormalizedAlert,
      delivery: DeliveryContext,
    ): Promise<void> {
      await appendSessionAlert(sessionId, groupKey, alert, delivery);
      const arr = inbox.get(sessionId) ?? [];
      arr.push(alert);
      inbox.set(sessionId, arr);
    },

    drainInbox,

    stop(sessionId: string): boolean {
      const controller = controllers.get(sessionId);
      if (!controller) return false;
      controller.abort();
      return true;
    },
  };
}

export const dispatcher = createDispatcher({ run: runSession });
