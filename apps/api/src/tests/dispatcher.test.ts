import { describe, it, expect } from "vitest";
import { createDispatcher } from "../dispatch/dispatcher.js";
import type { RunInvestigationInput } from "../investigation/loop.js";
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

function alertInput(
  sourceAlertId: string,
  token = "tok",
): RunInvestigationInput {
  const alert: NormalizedAlert = {
    sourceAlertId,
    token,
    targetIdentifier: "web-01",
    alertType: "HighCPU",
    severity: "warning",
    firedAt: new Date().toISOString(),
    rawPayload: {},
  };
  return { sessionId: `s-${sourceAlertId}`, token, alert };
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
    });

    d.dispatch(alertInput("a"));
    d.dispatch(alertInput("b"));
    // Both start immediately — no concurrency ceiling
    expect(started).toEqual(["s-a", "s-b"]);

    gate.resolve();
  });

  it("dedup keyed by tokenId+sourceAlertId; clears when settled", async () => {
    const gate = deferred();
    const d = createDispatcher({ run: () => gate.promise });

    d.dispatch(alertInput("dup", "tok-1"));

    // Same token + sourceAlertId → duplicate
    expect(d.isInvestigating("tok-1", "dup")).toBe(true);
    // Same sourceAlertId but DIFFERENT token → not a duplicate
    expect(d.isInvestigating("tok-2", "dup")).toBe(false);
    expect(d.isInvestigating("tok-1", "never")).toBe(false);

    gate.resolve();
    await flush();

    expect(d.isInvestigating("tok-1", "dup")).toBe(false);
  });

  it("getActiveAlertSession returns the running alert session, null otherwise", async () => {
    const gate = deferred();
    const d = createDispatcher({ run: () => gate.promise });

    expect(d.getActiveAlertSession()).toBeNull();

    d.dispatch(alertInput("a"));
    expect(d.getActiveAlertSession()).toBe("s-a");

    gate.resolve();
    await flush();

    expect(d.getActiveAlertSession()).toBeNull();
  });

  it("getActiveAlertSession is null for chat/resume inputs (no alert)", async () => {
    const gate = deferred();
    const d = createDispatcher({ run: () => gate.promise });

    d.dispatch({ sessionId: "chat-1", token: "tok-1" });
    expect(d.getActiveAlertSession()).toBeNull();

    gate.resolve();
  });

  it("does not track chat/resume inputs for dedup", async () => {
    const gate = deferred();
    const d = createDispatcher({ run: () => gate.promise });

    d.dispatch({ sessionId: "chat-1", token: "tok-1" });
    expect(d.isInvestigating("tok-1", "anything")).toBe(false);

    gate.resolve();
  });

  it("isSessionRunning is true while running, false after settled", async () => {
    const gate = deferred();
    const d = createDispatcher({ run: () => gate.promise });

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
    });

    d.dispatch(alertInput("primary"));
    const primaryId = "s-primary";

    const leftover: NormalizedAlert = {
      sourceAlertId: "leftover",
      token: "tok",
      targetIdentifier: "web-01",
      alertType: "HighCPU",
      severity: "warning",
      firedAt: new Date().toISOString(),
      rawPayload: {},
    };
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
});
