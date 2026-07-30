import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { RunnerCommandMessage } from "@nightwarden/shared";

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

import { generateRunnerToken } from "../db/runner.js";
import { useTempDb } from "./temp-db.js";
import { mintTestSession } from "./session-helper.js";
import { waitFor } from "./wait.js";
import { registerConsoleEventRoutes } from "../session/events.js";
import { connectConsoleEvents } from "./console-events-helper.js";
import { registerSessionRoutes } from "../session/routes.js";
import { dispatcher } from "../dispatcher.js";
import { hasPendingHumanInput } from "../db/interrupts.js";
import {
  registerRunner,
  setRunnerManifest,
  unregisterRunner,
} from "../ws/fleet.js";
import type { RunnerConnection } from "../ws/fleet.js";
import { resolveCommand } from "../ws/command-transport.js";
import { updateConfig } from "../config/store.js";
import { mountApi } from "./api-server.js";

// A free-form text finish: no tool call ends the run successfully.
const FINISH_TURN: ScriptedTurn = {
  text: "Investigation complete.",
  toolUses: [],
};

describe("continue-request interrupts", () => {
  let server: FastifyInstance;
  let port: number;
  let cleanupDb: () => void;
  let SESSION: string;
  let TEST_TOKEN: string;
  let conn: RunnerConnection;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();
    TEST_TOKEN = generateRunnerToken("docker", "continue-032").id;

    conn = registerRunner({
      runnerId: TEST_TOKEN,
      platform: "docker",
      send: (raw: string) => {
        const msg = JSON.parse(raw) as RunnerCommandMessage;
        const {
          commandName: _cn,
          commandInput: _ci,
          correlationId,
        } = msg.payload;
        resolveCommand({ correlationId, success: true, result: [] });
      },
      close: () => {},
    });
    setRunnerManifest(TEST_TOKEN, {
      hostname: "continue-host",
      runnerVersion: "2.0.0",
      capabilities: {
        docker: true,
        kubernetes: false,
        services: [
          {
            identity: {
              provider: "docker",
              project: "web-01",
              service: "api",
            },
            status: "running",
          },
        ],
        postgres: { available: false },
        redis: { available: false },
      },
    });

    server = Fastify({ logger: false, forceCloseConnections: true });
    await mountApi(server, registerConsoleEventRoutes);
    await mountApi(server, registerSessionRoutes);
    await server.listen({ port: 0, host: "127.0.0.1" });
    port = (server.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    unregisterRunner(conn);
    await server.close();
    cleanupDb();
    vi.unstubAllEnvs();
  });

  it("cuts a turn short when the budget runs out mid-request, and checks in rather than failing", async () => {
    // The deadline is propagated into the request itself, so a turn already in
    // flight is aborted. That abort is the check-in, not a run failure.
    const gates = createGateController();
    updateConfig({ checkInAfterMs: 200 });
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

      await waitFor(() => hasPendingHumanInput(sessionId));
      expect(dispatcher.isSessionRunning(sessionId)).toBe(false);
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
    updateConfig({ checkInAfterMs: 0 });
    setScript([FINISH_TURN]);

    const { events, close } = await connectConsoleEvents(port, SESSION);

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
    expect(dispatcher.isSessionRunning(sessionId)).toBe(false);

    // DB row must have kind=continue
    expect(hasPendingHumanInput(sessionId)).toBe(true);

    // INTERRUPT event carries kind=continue and no tool-specific payload
    expect(interrupt.payload["kind"]).toBe("continue");
    expect(interrupt.payload["toolName"]).toBe("");

    close();

    // cleanup: end the investigation
    await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ decision: "reject" }),
    });
    await waitFor(() => !hasPendingHumanInput(sessionId));
  });

  it("continuing resumes with fresh deadline and run completes", async () => {
    updateConfig({ checkInAfterMs: 0 });
    setScript([FINISH_TURN]);

    const { events, close } = await connectConsoleEvents(port, SESSION);

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
    expect(hasPendingHumanInput(sessionId)).toBe(true);

    // Grant a fresh deadline before responding
    updateConfig({ checkInAfterMs: 300_000 });

    // Respond to continue (no decision = continue)
    const continueRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({ resolvedBy: "operator" }),
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
    await waitFor(() => !hasPendingHumanInput(sessionId));
    expect(hasPendingHumanInput(sessionId)).toBe(false);
    await waitFor(() => !dispatcher.isSessionRunning(sessionId));
    expect(dispatcher.isSessionRunning(sessionId)).toBe(false);

    close();
  });

  it("ending runs a wrap-up turn and finishes the investigation", async () => {
    updateConfig({ checkInAfterMs: 0 });
    setScript([FINISH_TURN]);

    const { events, close } = await connectConsoleEvents(port, SESSION);

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
        body: JSON.stringify({ decision: "reject", resolvedBy: "operator" }),
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

    // Interrupt row gone, wrap-up run completes
    await waitFor(() => !hasPendingHumanInput(sessionId));
    await waitFor(() => !dispatcher.isSessionRunning(sessionId));
    expect(dispatcher.isSessionRunning(sessionId)).toBe(false);

    close();
  });

  it("restart-resume: continue interrupt survives process exit, resolve still works", async () => {
    updateConfig({ checkInAfterMs: 0 });
    setScript([FINISH_TURN]);

    const { events, close } = await connectConsoleEvents(port, SESSION);

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
    expect(dispatcher.isSessionRunning(sessionId)).toBe(false);
    expect(hasPendingHumanInput(sessionId)).toBe(true);

    // Grant a fresh deadline before responding (mimics operator action after restart)
    updateConfig({ checkInAfterMs: 300_000 });

    // Resolve purely from DB state
    const resumeRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({ resolvedBy: "operator-after-restart" }),
      },
    );
    expect(resumeRes.status).toBe(200);

    // Interrupt row gone, run resumes and completes
    await waitFor(() => !hasPendingHumanInput(sessionId));
    expect(hasPendingHumanInput(sessionId)).toBe(false);

    close();
  });

  it("config has no tool-call budget field", () => {
    const config = updateConfig({});
    expect(Object.keys(config)).not.toContain("maxToolCalls");
  });
});
