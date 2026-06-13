import { describe, it, expect } from "vitest";
import { createDispatcher } from "../dispatch/dispatcher.js";
import type { RunInvestigationInput } from "../investigation/loop.js";
import type { NormalizedAlert } from "@nightwatch/shared";

// A controllable unit of work: dispatch starts it, the test settles it by hand.
// This lets the concurrency, FIFO, and drop behavior be asserted deterministically
// without driving the whole investigation loop.
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Drain all pending microtasks. A settle -> drain -> settle chain hops through
// several promise ticks (the run wrapper's .catch().finally()), so a single
// macrotask boundary is the deterministic way to let the dispatcher quiesce.
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
  return { sessionId: `s-${sourceAlertId}`, token, trigger: "alert", alert };
}

describe("dispatcher", () => {
  it("runs work immediately while under the concurrency cap", async () => {
    const started: string[] = [];
    const gate = deferred();
    const d = createDispatcher({
      maxConcurrent: 2,
      maxQueue: 10,
      run: (input) => {
        started.push(input.sessionId);
        return gate.promise;
      },
    });

    expect(d.dispatch(alertInput("a"))).toBe(true);
    expect(d.dispatch(alertInput("b"))).toBe(true);
    // Both are under the cap of 2, so both start synchronously on dispatch.
    expect(started).toEqual(["s-a", "s-b"]);

    gate.resolve();
  });

  it("caps concurrency and drains the queue in FIFO order as slots free", async () => {
    const started: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const d = createDispatcher({
      maxConcurrent: 1,
      maxQueue: 10,
      run: (input) => {
        started.push(input.sessionId);
        const g = deferred();
        gates.set(input.sessionId, g);
        return g.promise;
      },
    });

    d.dispatch(alertInput("a"));
    d.dispatch(alertInput("b"));
    d.dispatch(alertInput("c"));

    // Only the first runs; b and c wait behind the cap of 1.
    expect(started).toEqual(["s-a"]);

    // Finish a -> b drains. Finish b -> c drains. Strict FIFO.
    gates.get("s-a")!.resolve();
    await flush();
    expect(started).toEqual(["s-a", "s-b"]);

    gates.get("s-b")!.resolve();
    await flush();
    expect(started).toEqual(["s-a", "s-b", "s-c"]);

    gates.get("s-c")!.resolve();
  });

  it("drops new work and reports it once active + queue are full", async () => {
    const gate = deferred();
    const d = createDispatcher({
      maxConcurrent: 1,
      maxQueue: 1,
      run: () => gate.promise,
    });

    expect(d.dispatch(alertInput("a"))).toBe(true); // active
    expect(d.dispatch(alertInput("b"))).toBe(true); // queued (queue size 1)
    expect(d.dispatch(alertInput("c"))).toBe(false); // dropped: no slot, queue full

    gate.resolve();
  });

  it("reports an active or queued alert for dedup, and clears it once settled", async () => {
    const gate = deferred();
    const d = createDispatcher({
      maxConcurrent: 1,
      maxQueue: 10,
      run: () => gate.promise,
    });

    d.dispatch(alertInput("dup", "tok-1"));
    d.dispatch(alertInput("dup-q", "tok-1")); // queued, still counts

    expect(d.isInvestigating("tok-1", "dup")).toBe(true);
    expect(d.isInvestigating("tok-1", "dup-q")).toBe(true);
    // Same id on a different token is not the same alert.
    expect(d.isInvestigating("tok-2", "dup")).toBe(false);
    expect(d.isInvestigating("tok-1", "never")).toBe(false);

    gate.resolve();
    await flush();

    // Both runs have settled; their dedup keys are released so a re-fire
    // re-investigates.
    expect(d.isInvestigating("tok-1", "dup")).toBe(false);
    expect(d.isInvestigating("tok-1", "dup-q")).toBe(false);
  });

  it("does not track chat/resume inputs (no alert) for dedup", async () => {
    const gate = deferred();
    const d = createDispatcher({
      maxConcurrent: 2,
      maxQueue: 10,
      run: () => gate.promise,
    });

    d.dispatch({ sessionId: "chat-1", token: "tok-1", trigger: "chat" });
    expect(d.isInvestigating("tok-1", "anything")).toBe(false);

    gate.resolve();
  });
});
