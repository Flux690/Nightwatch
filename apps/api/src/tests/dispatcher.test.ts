import { describe, it, expect } from "vitest";
import { createDispatcher } from "../dispatcher.js";
import type { RunInvestigationInput } from "../agent/loop.js";
import type { NormalizedAlert } from "@nightwatch/shared";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Drain all pending microtasks through the async promise chain (.catch, .finally).
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeAlert(
  sourceAlertId: string,
  runnerId = "runner-1",
): NormalizedAlert {
  return {
    sourceAlertId,
    runnerId,
    targetIdentifier: "web-01",
    alertType: "HighCPU",
    severity: "warning",
    firedAt: new Date().toISOString(),
    rawPayload: {},
  };
}

function alertInput(
  sourceAlertId: string,
  runnerId = "runner-1",
): RunInvestigationInput {
  return {
    sessionId: `s-${sourceAlertId}`,
    alert: makeAlert(sourceAlertId, runnerId),
  };
}

// Fakes the durable session->alert lookup (the real one is
// `getSession(id)?.originatingAlert ?? null`). Tests register a session's alert
// here the same way `createSession` would have persisted it, so a resumed
// dispatch (no `input.alert`) still resolves correctly via the lookup fallback.
function fakeAlertLookup(): {
  getAlertForSession: (sessionId: string) => NormalizedAlert | null;
  register: (sessionId: string, alert: NormalizedAlert) => void;
} {
  const bySession = new Map<string, NormalizedAlert>();
  return {
    getAlertForSession: (sessionId) => bySession.get(sessionId) ?? null,
    register: (sessionId, alert) => bySession.set(sessionId, alert),
  };
}

// No lookup match for any session — for tests that only exercise input.alert
// (the lookup is purely a resume-time fallback) or chat/resume-without-alert.
function noAlertLookup(): NormalizedAlert | null {
  return null;
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
      getAlertForSession: noAlertLookup,
    });

    d.dispatch(alertInput("a"));
    d.dispatch(alertInput("b"));
    // Both start immediately — no concurrency ceiling
    expect(started).toEqual(["s-a", "s-b"]);

    gate.resolve();
  });

  it("dedup keyed by runnerId+sourceAlertId; clears when settled", async () => {
    const gate = deferred();
    const d = createDispatcher({
      run: () => gate.promise,
      getAlertForSession: noAlertLookup,
    });

    d.dispatch(alertInput("dup", "runner-1"));

    // Same token + sourceAlertId → duplicate
    expect(d.isInvestigating("runner-1", "dup")).toBe(true);
    // Same sourceAlertId but DIFFERENT runner → not a duplicate
    expect(d.isInvestigating("runner-2", "dup")).toBe(false);
    expect(d.isInvestigating("runner-1", "never")).toBe(false);

    gate.resolve();
    await flush();

    expect(d.isInvestigating("runner-1", "dup")).toBe(false);
  });

  it("getActiveAlertSession returns the running alert session, null otherwise", async () => {
    const gate = deferred();
    const lookup = fakeAlertLookup();
    const d = createDispatcher({
      run: () => gate.promise,
      getAlertForSession: lookup.getAlertForSession,
    });

    expect(d.getActiveAlertSession()).toBeNull();

    const input = alertInput("a");
    lookup.register(input.sessionId, input.alert!);
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
      getAlertForSession: noAlertLookup,
    });

    d.dispatch({ sessionId: "chat-1" });
    expect(d.getActiveAlertSession()).toBeNull();

    gate.resolve();
  });

  it("does not track chat/resume inputs for dedup", async () => {
    const gate = deferred();
    const d = createDispatcher({
      run: () => gate.promise,
      getAlertForSession: noAlertLookup,
    });

    d.dispatch({ sessionId: "chat-1" });
    expect(d.isInvestigating("runner-1", "anything")).toBe(false);

    gate.resolve();
  });

  it("isSessionRunning is true while running, false after settled", async () => {
    const gate = deferred();
    const d = createDispatcher({
      run: () => gate.promise,
      getAlertForSession: noAlertLookup,
    });

    d.dispatch(alertInput("a"));
    expect(d.isSessionRunning("s-a")).toBe(true);

    gate.resolve();
    await flush();

    expect(d.isSessionRunning("s-a")).toBe(false);
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
      getAlertForSession: noAlertLookup,
    });

    d.dispatch(alertInput("primary"));
    const primaryId = "s-primary";

    const leftover = makeAlert("leftover");
    d.injectAlert(primaryId, leftover);

    gates.get(primaryId)!.resolve();
    // Two flushes: the finally block runs, then the newly dispatched run starts.
    await flush();
    await flush();

    expect(started.length).toBe(2);
    expect(started[1]).not.toBe(primaryId);

    // Clean up the leftover run
    gates.get(started[1]!)?.resolve();
  });

  // resume dispatch never carries input.alert; all alert-derived behavior must fall back to the session lookup
  describe("resumed alert runs (no input.alert, derived via lookup)", () => {
    it("getActiveAlertSession recovers the alert session on resume", async () => {
      const gate = deferred();
      const lookup = fakeAlertLookup();
      const d = createDispatcher({
        run: () => gate.promise,
        getAlertForSession: lookup.getAlertForSession,
      });

      const resumedAlert = makeAlert("resumed");
      lookup.register("s-resumed", resumedAlert);

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
        getAlertForSession: lookup.getAlertForSession,
      });

      const resumedAlert = makeAlert("resumed-dup", "runner-9");
      lookup.register("s-resumed-dup", resumedAlert);

      d.dispatch({
        sessionId: "s-resumed-dup",
        seed: [],
        resumeToolResults: [],
      });

      expect(d.isInvestigating("runner-9", "resumed-dup")).toBe(true);

      gate.resolve();
      await flush();

      expect(d.isInvestigating("runner-9", "resumed-dup")).toBe(false);
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
        getAlertForSession: lookup.getAlertForSession,
      });

      const resumedAlert = makeAlert("resumed-leftover");
      lookup.register("s-resumed-leftover", resumedAlert);
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
