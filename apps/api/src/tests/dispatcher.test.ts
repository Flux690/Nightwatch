import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";
import { createDispatcher } from "../dispatcher.js";
import type { RunSessionInput, RunOutcome } from "../agent/loop.js";
import type { NormalizedAlert } from "@nightwarden/shared";
import { updateConfig } from "../config/store.js";
import {
  countInvestigations,
  createSession,
  enqueueAlerts,
  getSession,
  listSessionSources,
  queueDepth,
} from "../db/sessions.js";
import { seedAlertSession, WHOLE_DELIVERY } from "./session-helper.js";
import { useTempDb } from "./temp-db.js";

// The gate resolves with a run outcome; these tests exercise claiming, seats and
// promotion, so a plain "completed" stands in for every run.
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
    annotations: {},
    generatorURL: null,
    rawPayload: {},
  };
}

// Every session row exists before anything dispatches into it: the chat route
// writes it, and promotion writes it together with the alerts it takes.
function seedSession(sessionId: string, alerts: NormalizedAlert[]): void {
  seedAlertSession(
    { sessionId, title: "t", createdAt: new Date().toISOString() },
    alerts,
  );
}

describe("dispatcher", () => {
  // Claiming a run and counting seats are both reads of the session row, so this
  // seam needs a database even with the run itself faked.
  let cleanupDb: () => void;
  beforeAll(() => {
    cleanupDb = useTempDb();
  });
  afterAll(() => {
    cleanupDb();
    vi.unstubAllEnvs();
  });

  it("refuses to dispatch into a session nothing has written", () => {
    const dispatcher = createDispatcher({
      run: () => Promise.resolve<RunOutcome>("completed"),
    });
    expect(dispatcher.dispatch({ sessionId: "never-created" })).toBe(false);
  });

  /* The conditional UPDATE is the mutex, not a check before it: two dispatches
     arriving together both reach it and only one changes the row, so the loser is
     told rather than colliding on the transcript's primary key. */
  it("refuses a second dispatch for a session a run already holds", async () => {
    const gate = deferred();
    const dispatcher = createDispatcher({ run: () => gate.promise });
    const sessionId = "s-race";
    seedSession(sessionId, [makeAlert("race-1")]);

    expect(dispatcher.dispatch({ sessionId })).toBe(true);
    expect(dispatcher.dispatch({ sessionId })).toBe(false);
    expect(dispatcher.isSessionRunning(sessionId)).toBe(true);

    gate.resolve();
    await flush();
    expect(dispatcher.isSessionRunning(sessionId)).toBe(false);
    // Released, so the same session can run again - which is what a resume is.
    expect(dispatcher.dispatch({ sessionId })).toBe(true);
  });

  it("stop aborts the running session's signal, and answers false for an idle one", async () => {
    let seen: AbortSignal | undefined;
    const gate = deferred();
    const dispatcher = createDispatcher({
      run: (input: RunSessionInput) => {
        seen = input.signal;
        return gate.promise;
      },
    });
    const sessionId = "s-stop";
    seedSession(sessionId, [makeAlert("stop-1")]);

    expect(dispatcher.stop(sessionId)).toBe(false);
    dispatcher.dispatch({ sessionId });
    expect(dispatcher.stop(sessionId)).toBe(true);
    expect(seen?.aborted).toBe(true);

    gate.resolve();
    await flush();
    expect(dispatcher.stop(sessionId)).toBe(false);
  });

  describe("promotion", () => {
    /* A seat is held from the moment a run starts until it ends, so what frees
       one is a run finishing - and that is the only thing that starts the next
       waiting group. Nothing polls, and no timer decides. */
    it("starts a waiting group only when a run ends and frees its seat", async () => {
      updateConfig({ maxConcurrentInvestigations: 1 });
      const gate = deferred();
      const dispatcher = createDispatcher({ run: () => gate.promise });
      const before = countInvestigations();

      const holder = "s-holder";
      seedSession(holder, [makeAlert("hold-1")]);
      dispatcher.dispatch({ sessionId: holder });

      enqueueAlerts("group-waiting", [makeAlert("wait-1")], WHOLE_DELIVERY);
      dispatcher.promoteQueued();
      // The only seat is taken, so the group stays where it is: durable, and
      // still nobody's.
      expect(queueDepth().waiting).toBe(1);
      expect(countInvestigations()).toBe(before + 1);

      gate.resolve();
      await flush();
      expect(queueDepth().waiting).toBe(0);
      expect(countInvestigations()).toBe(before + 2);
      updateConfig({ maxConcurrentInvestigations: 10 });
    });

    it("takes the oldest waiting group first, and takes it whole", () => {
      updateConfig({ maxConcurrentInvestigations: 1 });
      const gate = deferred();
      const dispatcher = createDispatcher({ run: () => gate.promise });

      enqueueAlerts(
        "group-older",
        [makeAlert("old-1"), makeAlert("old-2")],
        WHOLE_DELIVERY,
      );
      enqueueAlerts("group-newer", [makeAlert("new-1")], WHOLE_DELIVERY);

      // One seat, so exactly one group starts and it is the one that arrived
      // first. The newer group waits rather than being swept in with it.
      dispatcher.promoteQueued();
      expect(queueDepth().waiting).toBe(1);

      const started = investigationAlertIds().find((ids) =>
        ids.includes("old-1"),
      );
      expect(started).toEqual(["old-1", "old-2"]);
      expect(investigationAlertIds().some((ids) => ids.includes("new-1"))).toBe(
        false,
      );

      gate.resolve();
      updateConfig({ maxConcurrentInvestigations: 10 });
    });
  });

  it("injecting records the alert on the session and hands it to the run once", () => {
    const dispatcher = createDispatcher({
      run: () => Promise.resolve<RunOutcome>("completed"),
    });
    const sessionId = "s-inject";
    seedSession(sessionId, [makeAlert("inject-primary")]);

    dispatcher.injectAlert(
      sessionId,
      "group-inject",
      makeAlert("inject-late"),
      WHOLE_DELIVERY,
    );

    // Durable immediately, because the sender was already answered 200.
    expect(alertIdsOf(sessionId)).toEqual(["inject-primary", "inject-late"]);
    // The inbox is what tells the model, which is a separate concern from
    // keeping it - and it is drained exactly once.
    expect(
      dispatcher.drainInbox(sessionId).map((a) => a.sourceAlertId),
    ).toEqual(["inject-late"]);
    expect(dispatcher.drainInbox(sessionId)).toEqual([]);
  });

  it("does not count a chat against the investigation seats", () => {
    const gate = deferred();
    const dispatcher = createDispatcher({ run: () => gate.promise });
    const sessionId = "s-chat";
    createSession({
      sessionId,
      title: "t",
      createdAt: new Date().toISOString(),
    });

    updateConfig({ maxConcurrentInvestigations: 1 });
    dispatcher.dispatch({ sessionId, userMessage: "hello" });

    // One chat is running; the investigation pool is still untouched, so a
    // waiting alert group can start.
    const before = countInvestigations();
    enqueueAlerts("group-beside-chat", [makeAlert("beside-1")], WHOLE_DELIVERY);
    dispatcher.promoteQueued();
    expect(countInvestigations()).toBe(before + 1);

    gate.resolve();
    updateConfig({ maxConcurrentInvestigations: 10 });
  });
});

// Every investigation, as the alert ids it covers - which is what says whether a
// group was taken whole and whether two groups stayed apart.
function investigationAlertIds(): string[][] {
  return listSessionSources(100, 0, "investigation").sources.map((s) =>
    s.alerts.map((entry) => entry.alert.sourceAlertId),
  );
}

function alertIdsOf(sessionId: string): string[] {
  return (getSession(sessionId)?.alerts ?? []).map(
    (entry) => entry.alert.sourceAlertId,
  );
}
