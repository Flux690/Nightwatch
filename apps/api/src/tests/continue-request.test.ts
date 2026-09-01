import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { harness, type Harness } from "./harness.js";

vi.mock("../llm/factory.js", () => import("./llm-factory-mock.js"));

import { mockCreateProvider } from "./llm-factory-mock.js";

import {
  createGateController,
  createScriptRunner,
  type ScriptedTurn,
} from "./contract-fake-provider.js";

const scriptRunner = createScriptRunner();
mockCreateProvider.mockImplementation(() => scriptRunner.create());
const setScript = (turns: ScriptedTurn[]): void =>
  scriptRunner.setScript(turns);

import { waitFor } from "./wait.js";
import { registerFrontendEventRoutes } from "../session/events.js";
import { connectFrontendEvents } from "./frontend-events-helper.js";
import { registerSessionRoutes } from "../session/routes.js";
import { dispatcher } from "../dispatcher.js";
import { hasPendingHumanInput } from "../session/gate-store.js";
import { buildTranscript } from "../session/transcript.js";
import { updateConfig } from "../config/store.js";

// A free-form text finish: no tool call ends the run successfully.
const FINISH_TURN: ScriptedTurn = {
  text: "Investigation complete.",
  toolUses: [],
};

describe("continue-request interrupts", () => {
  let nw: Harness;
  let port: number;
  let SESSION: string;

  beforeAll(async () => {
    nw = await harness({
      routes: [registerFrontendEventRoutes, registerSessionRoutes],
      runners: [{ name: "continue-host", services: ["web-01/api"] }],
    });
    ({ port, session: SESSION } = nw);
  });

  afterAll(async () => {
    await nw.close();
    vi.unstubAllEnvs();
  });

  it("cuts a turn short when the budget runs out mid-request, and checks in rather than failing", async () => {
    // The deadline is propagated into the request itself, so a turn already in
    // flight is aborted. That abort is the check-in, not a run failure.
    const gates = createGateController();
    await updateConfig({ checkInAfterMs: 200 });
    setScript([FINISH_TURN]);

    let sessionId = "";
    try {
      mockCreateProvider.mockImplementation(() =>
        scriptRunner.create({ gate: gates.gate }),
      );
      const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({ message: "Take your time." }),
      });
      ({ sessionId } = (await res.json()) as { sessionId: string });

      // Park the only turn until well past the deadline, then let it go. The
      // turn is already in flight, so only a propagated deadline can end it.
      await new Promise((r) => setTimeout(r, 400));
      gates.releaseAll();

      await waitFor(async () => await hasPendingHumanInput(sessionId));
      expect(await dispatcher.isSessionRunning(sessionId)).toBe(false);
    } finally {
      gates.releaseAll();
      mockCreateProvider.mockImplementation(() => scriptRunner.create());
    }

    await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ decision: "end" }),
    });
  });

  it("checkInAfterMs=0 suspends immediately: kind=continue, HUMAN_INPUT_REQUIRED event, run exited", async () => {
    // Deadline expires before any turns run.
    await updateConfig({ checkInAfterMs: 0 });
    setScript([FINISH_TURN]);

    const { events, close } = await connectFrontendEvents(port, SESSION);

    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Investigate the service." }),
    });
    expect(res.status).toBe(202);
    const { sessionId } = (await res.json()) as { sessionId: string };

    const interrupt = await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId &&
          e.payload["kind"] === "continue",
      ),
    );

    // Run must have exited
    expect(await dispatcher.isSessionRunning(sessionId)).toBe(false);

    // DB row must have kind=continue
    expect(await hasPendingHumanInput(sessionId)).toBe(true);

    // INTERRUPT event carries kind=continue and no tool-specific payload
    expect(interrupt.payload["kind"]).toBe("continue");
    expect(interrupt.payload["toolName"]).toBe("");

    // And it survives a reload: published live, but absent from the saved
    // turns, so a refreshed page showed a parked run as an idle one.
    const parked = (await buildTranscript(sessionId)).filter(
      (item) => item.kind === "continue_card",
    );
    expect(parked).toHaveLength(1);
    expect(parked[0]?.kind === "continue_card" && parked[0].state).toEqual({
      phase: "awaiting_human",
    });

    close();

    await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ decision: "reject" }),
    });
    await waitFor(async () => !(await hasPendingHumanInput(sessionId)));
  });

  it("continuing resumes with fresh deadline and run completes", async () => {
    await updateConfig({ checkInAfterMs: 0 });
    setScript([FINISH_TURN]);

    const { events, close } = await connectFrontendEvents(port, SESSION);

    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Continue test." }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    // Wait for the continue interrupt
    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId &&
          e.payload["kind"] === "continue",
      ),
    );
    expect(await hasPendingHumanInput(sessionId)).toBe(true);

    // Grant a fresh deadline before responding
    await updateConfig({ checkInAfterMs: 300_000 });

    // Respond to continue (no decision = continue)
    const continueRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({}),
      },
    );
    expect(continueRes.status).toBe(200);
    const body = (await continueRes.json()) as { status: string };
    expect(body.status).toBe("continued");

    // HUMAN_INPUT_RESOLVED arrives with status=continued
    await waitFor(() =>
      events.some(
        (e) =>
          e.type === "HUMAN_INPUT_RESOLVED" &&
          e.payload["sessionId"] === sessionId &&
          e.payload["status"] === "continued",
      ),
    );

    // Interrupt row is gone, run completes (FINISH_TURN script)
    await waitFor(async () => !(await hasPendingHumanInput(sessionId)));
    expect(await hasPendingHumanInput(sessionId)).toBe(false);
    await waitFor(async () => !(await dispatcher.isSessionRunning(sessionId)));
    expect(await dispatcher.isSessionRunning(sessionId)).toBe(false);

    close();
  });

  it("ending runs a closing turn and finishes the investigation", async () => {
    await updateConfig({ checkInAfterMs: 0 });
    setScript([FINISH_TURN]);

    const { events, close } = await connectFrontendEvents(port, SESSION);

    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "End test." }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId &&
          e.payload["kind"] === "continue",
      ),
    );

    // Respond with reject = end investigation
    const endRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({ decision: "reject" }),
      },
    );
    expect(endRes.status).toBe(200);
    const body = (await endRes.json()) as { status: string };
    expect(body.status).toBe("rejected");

    // HUMAN_INPUT_RESOLVED arrives with status=rejected
    await waitFor(() =>
      events.some(
        (e) =>
          e.type === "HUMAN_INPUT_RESOLVED" &&
          e.payload["sessionId"] === sessionId &&
          e.payload["status"] === "rejected",
      ),
    );

    // Interrupt row gone, closing run completes
    await waitFor(async () => !(await hasPendingHumanInput(sessionId)));
    await waitFor(async () => !(await dispatcher.isSessionRunning(sessionId)));
    expect(await dispatcher.isSessionRunning(sessionId)).toBe(false);

    close();
  });

  it("restart-resume: continue interrupt survives process exit, resolve still works", async () => {
    await updateConfig({ checkInAfterMs: 0 });
    setScript([FINISH_TURN]);

    const { events, close } = await connectFrontendEvents(port, SESSION);

    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Durability test." }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId &&
          e.payload["kind"] === "continue",
      ),
    );

    // Simulate process exit: run has exited, interrupt row is in DB
    expect(await dispatcher.isSessionRunning(sessionId)).toBe(false);
    expect(await hasPendingHumanInput(sessionId)).toBe(true);

    // Grant a fresh deadline before responding (mimics user action after restart)
    await updateConfig({ checkInAfterMs: 300_000 });

    // Resolve purely from DB state
    const resumeRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({}),
      },
    );
    expect(resumeRes.status).toBe(200);

    // Interrupt row gone, run resumes and completes
    await waitFor(async () => !(await hasPendingHumanInput(sessionId)));
    expect(await hasPendingHumanInput(sessionId)).toBe(false);

    close();
  });

  it("config has no tool-call budget field", async () => {
    const config = await updateConfig({});
    expect(Object.keys(config)).not.toContain("maxToolCalls");
  });
});
