import { runInvestigation } from "../investigation/loop.js";
import type { RunInvestigationInput } from "../investigation/loop.js";
import { logger } from "../logger.js";

// The single entry to the investigation loop (architecture invariant): alert,
// chat, and resume all funnel through dispatch(). It replaces the BullMQ queue +
// worker with a bounded in-process FIFO and a concurrency cap - the whole
// deployment is one Node process, so a queue that coordinates many instances is
// solving a problem that does not exist (CONTEXT.md D2).
export interface Dispatcher {
  // false means the work was dropped because the queue is full. The caller logs
  // and moves on; for an alert this is safe because the alert re-fires.
  dispatch(input: RunInvestigationInput): boolean;
  // Derived dedup source: true while a run for this token + sourceAlertId is
  // active or waiting in the queue. No keys, no TTLs - a crashed run leaves no
  // marker, so a re-fired alert re-investigates (CONTEXT.md D2/D4).
  isInvestigating(token: string, sourceAlertId: string): boolean;
}

export interface DispatcherOptions {
  run: (input: RunInvestigationInput) => Promise<void>;
  maxConcurrent: number;
  maxQueue: number;
}

// A NUL separator cannot appear in a token (base64url) or in a source alert
// id parsed from a JSON webhook, so token+sourceAlertId maps to exactly one
// key - no ambiguity between e.g. ("ab","c") and ("a","bc").
const KEY_SEP = "\u0000";
function dedupKey(token: string, sourceAlertId: string): string {
  return `${token}${KEY_SEP}${sourceAlertId}`;
}

export function createDispatcher(opts: DispatcherOptions): Dispatcher {
  const { run, maxConcurrent, maxQueue } = opts;

  interface Queued {
    input: RunInvestigationInput;
    key: string | null;
  }

  const queue: Queued[] = [];
  // Multiset: an alert key is present while any active-or-queued run carries it.
  const active = new Map<string, number>();
  let running = 0;

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

  function start(input: RunInvestigationInput, key: string | null): void {
    running++;
    void run(input)
      .catch((err: unknown) => {
        logger.error(
          { err, sessionId: input.sessionId },
          "investigation failed",
        );
      })
      .finally(() => {
        running--;
        release(key);
        drain();
      });
  }

  function drain(): void {
    if (running >= maxConcurrent) return;
    const next = queue.shift();
    if (!next) return;
    start(next.input, next.key);
  }

  return {
    dispatch(input: RunInvestigationInput): boolean {
      const key =
        input.alert != null
          ? dedupKey(input.alert.token, input.alert.sourceAlertId)
          : null;

      if (running >= maxConcurrent && queue.length >= maxQueue) {
        logger.warn(
          { sessionId: input.sessionId, queued: queue.length },
          "dispatch queue full, dropping investigation",
        );
        return false;
      }

      retain(key);
      if (running < maxConcurrent) start(input, key);
      else queue.push({ input, key });
      return true;
    },

    isInvestigating(token: string, sourceAlertId: string): boolean {
      return active.has(dedupKey(token, sourceAlertId));
    },
  };
}

const MAX_CONCURRENT = parseInt(
  process.env["INVESTIGATION_CONCURRENCY"] ?? "5",
  10,
);
// A bounded backlog: an alert storm queues up to this many, then drops (the
// alert re-fires). Prevents an unbounded queue from melting the API or the LLM bill.
const MAX_QUEUE = parseInt(process.env["INVESTIGATION_QUEUE_MAX"] ?? "100", 10);

export const dispatcher = createDispatcher({
  run: runInvestigation,
  maxConcurrent: MAX_CONCURRENT,
  maxQueue: MAX_QUEUE,
});
