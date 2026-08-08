import { describe, it, expect } from "vitest";
import { createDispatcher } from "../dispatcher.js";
import type { RunSessionInput, RunOutcome } from "../agent/loop.js";
import type { NormalizedAlert } from "@nightwarden/shared";

// The gate resolves with a run outcome; these tests only exercise dedup/running
// bookkeeping, so a plain "completed" stands in for every run.
function deferred(): { promise: Promise<RunOutcome>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<RunOutcome>((r) => {
    resolve = () => r("completed");
  });
  return { promise, resolve };
}

// Drain all pending microtasks through the async promise chain (.catch, .finally).
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const FIRED_AT = "2026-07-07T03:00:00.000Z";

function makeAlert(sourceAlertId: string, firedAt = FIRED_AT): NormalizedAlert {
  return {
    sourceAlertId,
    labels: {},
    alertType: "HighCPU",
    severity: "warning",
    firedAt,
    rawPayload: {},
  };
}

function alertInput(
  sourceAlertId: string,
  firedAt = FIRED_AT,
): RunSessionInput {
  return {
    sessionId: `s-${sourceAlertId}`,
    alerts: [makeAlert(sourceAlertId, firedAt)],
  };
}

// A whole batch on one session, none of them elected: this is what a 90s window
// produces, and every member has to dedup.
function batchInput(
  sessionId: string,
  sourceAlertIds: string[],
): RunSessionInput {
  return {
    sessionId,
    alerts: sourceAlertIds.map((id) => makeAlert(id)),
  };
}

// Fakes the durable session->alerts lookup (really getSession(id)?.alerts), so a
// resumed dispatch (no input.alerts) still resolves via the fallback.
function fakeAlertLookup(): {
  getAlertsForSession: (sessionId: string) => NormalizedAlert[];
  register: (sessionId: string, alerts: NormalizedAlert[]) => void;
} {
  const bySession = new Map<string, NormalizedAlert[]>();
  return {
    getAlertsForSession: (sessionId) => bySession.get(sessionId) ?? [],
    register: (sessionId, alerts) => bySession.set(sessionId, alerts),
  };
}

// No lookup match for any session — for tests that only exercise input.alerts
// (the lookup is purely a resume-time fallback) or chat/resume-without-alert.
function noAlertLookup(): NormalizedAlert[] {
  return [];
}

describe("dispatcher", () => {
  it("starts work immediately — no cap, no queue", async () => {
    const started: string[] = [];
    const gate = deferred();
    const d = createDispatcher({
      run: (input) => {
        started.push(input.sessionId);
        return gate.promise;
      },
      getAlertsForSession: noAlertLookup,
    });

    d.dispatch(alertInput("a"));
    d.dispatch(alertInput("b"));
    // Both start immediately — no concurrency ceiling
    expect(started).toEqual(["s-a", "s-b"]);

    gate.resolve();
  });

  it("dedup keyed by (fingerprint, startsAt); clears when settled", async () => {
    const gate = deferred();
    const d = createDispatcher({
      run: () => gate.promise,
      getAlertsForSession: noAlertLookup,
    });

    d.dispatch(alertInput("dup", FIRED_AT));

    // Same fingerprint + startsAt (a re-notification) → duplicate
    expect(d.isInvestigating("dup", FIRED_AT)).toBe(true);
    // Same fingerprint but a DIFFERENT startsAt: a twin incident that fired
    // independently (identical labels on another stack) → not a duplicate
    expect(d.isInvestigating("dup", "2026-07-07T03:05:00.000Z")).toBe(false);
    expect(d.isInvestigating("never", FIRED_AT)).toBe(false);

    gate.resolve();
    await flush();

    expect(d.isInvestigating("dup", FIRED_AT)).toBe(false);
  });

  it("dedups every alert of a batch, not whichever arrived first", async () => {
    // A window elects no primary, so a re-notification of the tenth member is
    // as much a duplicate as one of the first. Keying on one would let the rest
    // through, and each would then be injected into the run already handling it.
    const gate = deferred();
    const d = createDispatcher({
      run: () => gate.promise,
      getAlertsForSession: noAlertLookup,
    });

    d.dispatch(batchInput("s-batch", ["first", "second", "third"]));

    for (const id of ["first", "second", "third"]) {
      expect(d.isInvestigating(id, FIRED_AT)).toBe(true);
    }

    // An alert that arrives mid-run joins the set the run is covering, so its
    // own re-notification dedups too.
    d.injectAlert("s-batch", makeAlert("fourth"));
    expect(d.isInvestigating("fourth", FIRED_AT)).toBe(true);

    gate.resolve();
    await flush();

    expect(d.isInvestigating("second", FIRED_AT)).toBe(false);
  });

  it("getActiveAlertSession returns the running alert session, null otherwise", async () => {
    const gate = deferred();
    const lookup = fakeAlertLookup();
    const d = createDispatcher({
      run: () => gate.promise,
      getAlertsForSession: lookup.getAlertsForSession,
    });

    expect(d.getActiveAlertSession()).toBeNull();

    const input = alertInput("a");
    lookup.register(input.sessionId, input.alerts!);
    d.dispatch(input);
    expect(d.getActiveAlertSession()).toBe("s-a");

    gate.resolve();
    await flush();

    expect(d.getActiveAlertSession()).toBeNull();
  });

  it("getActiveAlertSession is null for chat/resume inputs (no alert)", async () => {
    const gate = deferred();
    const d = createDispatcher({
      run: () => gate.promise,
      getAlertsForSession: noAlertLookup,
    });

    d.dispatch({ sessionId: "chat-1" });
    expect(d.getActiveAlertSession()).toBeNull();

    gate.resolve();
  });

  it("does not track chat/resume inputs for dedup", async () => {
    const gate = deferred();
    const d = createDispatcher({
      run: () => gate.promise,
      getAlertsForSession: noAlertLookup,
    });

    d.dispatch({ sessionId: "chat-1" });
    expect(d.isInvestigating("anything", FIRED_AT)).toBe(false);

    gate.resolve();
  });

  it("isSessionRunning is true while running, false after settled", async () => {
    const gate = deferred();
    const d = createDispatcher({
      run: () => gate.promise,
      getAlertsForSession: noAlertLookup,
    });

    d.dispatch(alertInput("a"));
    expect(d.isSessionRunning("s-a")).toBe(true);

    gate.resolve();
    await flush();

    expect(d.isSessionRunning("s-a")).toBe(false);
  });

  it("stop aborts the signal passed to the running input and returns true", async () => {
    const gate = deferred();
    let receivedSignal: AbortSignal | undefined;
    const d = createDispatcher({
      run: (input) => {
        receivedSignal = input.signal;
        return gate.promise;
      },
      getAlertsForSession: noAlertLookup,
    });

    d.dispatch(alertInput("a"));
    expect(receivedSignal?.aborted).toBe(false);

    expect(d.stop("s-a")).toBe(true);
    expect(receivedSignal?.aborted).toBe(true);

    gate.resolve();
    await flush();
  });

  it("stop returns false for a session that is not running", () => {
    const d = createDispatcher({
      run: () => Promise.resolve<RunOutcome>("completed"),
      getAlertsForSession: noAlertLookup,
    });

    expect(d.stop("unknown")).toBe(false);
  });

  it("inbox leftovers re-dispatch as new sessions when the run ends", async () => {
    const started: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const d = createDispatcher({
      run: (input) => {
        started.push(input.sessionId);
        const g = deferred();
        gates.set(input.sessionId, g);
        return g.promise;
      },
      getAlertsForSession: noAlertLookup,
    });

    d.dispatch(alertInput("primary"));
    const openedId = "s-primary";

    const leftover = makeAlert("leftover");
    d.injectAlert(openedId, leftover);

    gates.get(openedId)!.resolve();
    // Two flushes: the finally block runs, then the newly dispatched run starts.
    await flush();
    await flush();

    expect(started.length).toBe(2);
    expect(started[1]).not.toBe(openedId);

    gates.get(started[1]!)?.resolve();
  });

  // resume dispatch never carries input.alerts; all alert-derived behavior must fall back to the session lookup
  describe("resumed alert runs (no input.alerts, derived via lookup)", () => {
    it("getActiveAlertSession recovers the alert session on resume", async () => {
      const gate = deferred();
      const lookup = fakeAlertLookup();
      const d = createDispatcher({
        run: () => gate.promise,
        getAlertsForSession: lookup.getAlertsForSession,
      });

      const resumedAlert = makeAlert("resumed");
      lookup.register("s-resumed", [resumedAlert]);

      // Resume dispatch: no `alert` field, just seed + resumeToolResults.
      d.dispatch({ sessionId: "s-resumed", seed: [], resumeToolResults: [] });

      expect(d.getActiveAlertSession()).toBe("s-resumed");

      gate.resolve();
      await flush();

      expect(d.getActiveAlertSession()).toBeNull();
    });

    it("isInvestigating dedup is retained for a resumed alert run", async () => {
      const gate = deferred();
      const lookup = fakeAlertLookup();
      const d = createDispatcher({
        run: () => gate.promise,
        getAlertsForSession: lookup.getAlertsForSession,
      });

      const resumedAlert = makeAlert("resumed-dup");
      lookup.register("s-resumed-dup", [resumedAlert]);

      d.dispatch({
        sessionId: "s-resumed-dup",
        seed: [],
        resumeToolResults: [],
      });

      expect(d.isInvestigating("resumed-dup", FIRED_AT)).toBe(true);

      gate.resolve();
      await flush();

      expect(d.isInvestigating("resumed-dup", FIRED_AT)).toBe(false);
    });

    it("inbox leftovers re-dispatch when a resumed alert run ends", async () => {
      const started: string[] = [];
      const gates = new Map<string, ReturnType<typeof deferred>>();
      const lookup = fakeAlertLookup();
      const d = createDispatcher({
        run: (input) => {
          started.push(input.sessionId);
          const g = deferred();
          gates.set(input.sessionId, g);
          return g.promise;
        },
        getAlertsForSession: lookup.getAlertsForSession,
      });

      const resumedAlert = makeAlert("resumed-leftover");
      lookup.register("s-resumed-leftover", [resumedAlert]);
      d.dispatch({
        sessionId: "s-resumed-leftover",
        seed: [],
        resumeToolResults: [],
      });

      const leftover = makeAlert("leftover-after-resume");
      d.injectAlert("s-resumed-leftover", leftover);

      gates.get("s-resumed-leftover")!.resolve();
      await flush();
      await flush();

      expect(started.length).toBe(2);
      expect(started[1]).not.toBe("s-resumed-leftover");

      gates.get(started[1]!)?.resolve();
    });
  });
});
