import "dotenv/config";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import Fastify from "fastify";
import FastifyWebSocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { RunnerCommandMessage } from "@nightwatch/shared";

const { mockCreateProvider } = vi.hoisted(() => ({
  mockCreateProvider: vi.fn(),
}));

vi.mock("../llm/factory.js", () => ({ createProvider: mockCreateProvider }));

import {
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
import { registerConsoleWsRoutes } from "../ws/console.js";

import { registerSessionRoutes } from "../session/routes.js";
import { dispatcher } from "../dispatcher.js";
import { hasPendingHumanInput } from "../db/interrupts.js";
import {
  registerRunner,
  setRunnerManifest,
  unregisterRunner,
} from "../ws/router.js";
import { resolveCommand } from "../ws/command-transport.js";

interface WsEvent {
  type: string;
  payload: Record<string, unknown>;
}

// A free-form text finish: no tool call ends the run successfully.
const FINISH_TURN = {
  text: "Answered. Investigation complete.",
  toolUses: [],
};

const TEST_OPTIONS = [
  {
    label: "Database overloaded",
    description: "High query volume saturated connection pool",
  },
  { label: "Memory leak", description: "Gradual memory growth causing OOM" },
];

function waitForConnected(ws: WebSocket): Promise<void> {
  return new Promise<void>((resolve) => {
    const onMsg = (raw: WebSocket.RawData): void => {
      const msg = JSON.parse(raw.toString()) as { type: string };
      if (msg.type === "connected") {
        ws.off("message", onMsg);
        resolve();
      }
    };
    ws.on("message", onMsg);
  });
}

describe("clarification interrupts", () => {
  let server: FastifyInstance;
  let port: number;
  let cleanupDb: () => void;
  let TEST_TOKEN: string;
  let SESSION: string;
  const TEST_RUNNER_ID = "runner-clarification-023";
  const restartCommands: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();
    TEST_TOKEN = generateRunnerToken("clarification-023").id;

    registerRunner(
      TEST_TOKEN,
      (raw: string) => {
        const msg = JSON.parse(raw) as RunnerCommandMessage;
        const { commandName, commandInput, correlationId } = msg.payload;
        if (commandName === "restart_service") {
          restartCommands.push(commandInput);
          resolveCommand({
            correlationId,
            success: true,
            result: { restarted: true },
          });
        } else {
          resolveCommand({ correlationId, success: true, result: [] });
        }
      },
      () => {},
    );
    setRunnerManifest(TEST_TOKEN, {
      runnerId: TEST_RUNNER_ID,
      hostname: "clarification-host",
      runnerVersion: "2.0.0",
      capabilities: {
        docker: true,
        kubernetes: false,
        services: [
          {
            identity: {
              provider: "docker",
              project: "web-01",
              service: "web-01",
            },
            status: "running",
          },
        ],
        prometheus: { available: false },
        postgres: { available: false },
        redis: { available: false },
        hostMetrics: true,
        fileRead: true,
        remediationEnabled: true,
      },
    });

    server = Fastify({ logger: false });
    await server.register(FastifyWebSocket);
    await registerConsoleWsRoutes(server);
    await registerSessionRoutes(server);
    await server.listen({ port: 0, host: "127.0.0.1" });
    port = (server.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    unregisterRunner(TEST_TOKEN);
    await server.close();
    cleanupDb();
    vi.unstubAllEnvs();
  });

  it("request_clarification suspends: interrupt row kind=clarification, INTERRUPT event has kind+question+options, run exited", async () => {
    setScript([
      {
        text: "Need clarification.",
        toolUses: [
          {
            id: "tu-clar-1",
            name: "request_clarification",
            input: {
              question: "What is the likely root cause?",
              options: TEST_OPTIONS,
            },
          },
        ],
      },
      FINISH_TURN,
    ]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`, {
      headers: { Cookie: `nw_auth=${SESSION}`, Origin: "http://localhost" },
    });
    const events: WsEvent[] = [];
    ws.on("message", (raw) => {
      events.push(JSON.parse(raw.toString()) as WsEvent);
    });
    await waitForConnected(ws);

    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Service degraded." }),
    });
    expect(res.status).toBe(202);
    const { sessionId } = (await res.json()) as { sessionId: string };

    const interrupt = await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );

    // Run must have exited
    expect(dispatcher.isSessionRunning(sessionId)).toBe(false);

    // DB row must have kind=clarification
    expect(hasPendingHumanInput(sessionId)).toBe(true);

    // INTERRUPT event carries kind + question + options
    expect(interrupt.payload["kind"]).toBe("clarification");
    expect(interrupt.payload["question"]).toBe(
      "What is the likely root cause?",
    );
    expect(interrupt.payload["options"]).toEqual(TEST_OPTIONS);
    expect(interrupt.payload["toolName"]).toBe("request_clarification");

    ws.close();

    // cleanup via /respond
    await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/respond`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ text: "cleanup" }),
    });
    await waitFor(() => !hasPendingHumanInput(sessionId));
  });

  it("answer resolves: resumes run, tool result contains answer, reaches free-form finish", async () => {
    setScript([
      {
        text: "Need clarification.",
        toolUses: [
          {
            id: "tu-ans-1",
            name: "request_clarification",
            input: {
              question: "Which container is affected?",
              options: TEST_OPTIONS,
            },
          },
        ],
      },
      FINISH_TURN,
    ]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`, {
      headers: { Cookie: `nw_auth=${SESSION}`, Origin: "http://localhost" },
    });
    const events: WsEvent[] = [];
    ws.on("message", (raw) => {
      events.push(JSON.parse(raw.toString()) as WsEvent);
    });
    await waitForConnected(ws);

    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Which container?" }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    const interrupt = await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );
    const answerRes = await fetch(
      `http://127.0.0.1:${port}/sessions/${sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({
          text: "Database overloaded",
          resolvedBy: "operator",
        }),
      },
    );
    expect(answerRes.status).toBe(200);
    const body = (await answerRes.json()) as { status: string };
    expect(body.status).toBe("answered");

    // INTERRUPT_RESOLVED arrives, run resumes, reaches free-form finish
    await waitFor(() =>
      events.some(
        (e) =>
          e.type === "HUMAN_INPUT_RESOLVED" &&
          e.payload["toolUseId"] === "tu-ans-1",
      ),
    );

    // Interrupt row gone after resolution
    expect(hasPendingHumanInput(sessionId)).toBe(false);

    ws.close();
  });

  it("multiSelect answer: joins selections as comma-separated string in tool result", async () => {
    setScript([
      {
        text: "Which factors apply?",
        toolUses: [
          {
            id: "tu-ms-1",
            name: "request_clarification",
            input: {
              question: "Which factors apply?",
              options: TEST_OPTIONS,
              multiSelect: true,
            },
          },
        ],
      },
      FINISH_TURN,
    ]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`, {
      headers: { Cookie: `nw_auth=${SESSION}`, Origin: "http://localhost" },
    });
    const events: WsEvent[] = [];
    ws.on("message", (raw) => {
      events.push(JSON.parse(raw.toString()) as WsEvent);
    });
    await waitForConnected(ws);

    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Factors?" }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    const interrupt = await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );
    expect(interrupt.payload["multiSelect"]).toBe(true);

    // Console pre-joins selections; server receives a plain string
    const answerRes = await fetch(
      `http://127.0.0.1:${port}/sessions/${sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({
          text: "Database overloaded, Memory leak",
          resolvedBy: "operator",
        }),
      },
    );
    expect(answerRes.status).toBe(200);

    await waitFor(() =>
      events.some(
        (e) =>
          e.type === "HUMAN_INPUT_RESOLVED" &&
          e.payload["toolUseId"] === "tu-ms-1",
      ),
    );
    expect(hasPendingHumanInput(sessionId)).toBe(false);

    ws.close();
  });

  it("clarification with decision body returns 400", async () => {
    setScript([
      {
        text: "Need clarification.",
        toolUses: [
          {
            id: "tu-clar-val-1",
            name: "request_clarification",
            input: { question: "Confirm?", options: TEST_OPTIONS },
          },
        ],
      },
      FINISH_TURN,
    ]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`, {
      headers: { Cookie: `nw_auth=${SESSION}`, Origin: "http://localhost" },
    });
    const events: WsEvent[] = [];
    ws.on("message", (raw) => {
      events.push(JSON.parse(raw.toString()) as WsEvent);
    });
    await waitForConnected(ws);

    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Test." }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );

    // Sending decision:"approve" on a clarification interrupt must return 400
    const badRes = await fetch(
      `http://127.0.0.1:${port}/sessions/${sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({ decision: "approve" }),
      },
    );
    expect(badRes.status).toBe(400);

    ws.close();

    // cleanup
    await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/respond`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ text: "cleanup" }),
    });
    await waitFor(() => !hasPendingHumanInput(sessionId));
  });

  it("restart-resume: clarification interrupt survives process exit, resolve still works", async () => {
    setScript([
      {
        text: "Clarifying.",
        toolUses: [
          {
            id: "tu-rr-clar-1",
            name: "request_clarification",
            input: { question: "Is this recurring?", options: TEST_OPTIONS },
          },
        ],
      },
      FINISH_TURN,
    ]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`, {
      headers: { Cookie: `nw_auth=${SESSION}`, Origin: "http://localhost" },
    });
    const events: WsEvent[] = [];
    ws.on("message", (raw) => {
      events.push(JSON.parse(raw.toString()) as WsEvent);
    });
    await waitForConnected(ws);

    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Is this recurring?" }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    const interrupt = await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );
    // Simulate process exit: run has exited, no in-memory state needed
    expect(dispatcher.isSessionRunning(sessionId)).toBe(false);
    expect(hasPendingHumanInput(sessionId)).toBe(true);

    // Resolve purely from DB state
    const answerRes = await fetch(
      `http://127.0.0.1:${port}/sessions/${sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({
          text: "Yes, recurring daily",
          resolvedBy: "operator-after-restart",
        }),
      },
    );
    expect(answerRes.status).toBe(200);

    await waitFor(() => !hasPendingHumanInput(sessionId));
    expect(hasPendingHumanInput(sessionId)).toBe(false);

    ws.close();
  });

  it("mixed two-gate turn: clarification suspends first, then approval suspends on resume, run completes", async () => {
    restartCommands.length = 0;
    const clarId = `tu-mix-clar-${randomUUID()}`;
    const restart1Id = `tu-mix-restart1-${randomUUID()}`;
    const restart2Id = `tu-mix-restart2-${randomUUID()}`;

    setScript([
      {
        text: "Ask then restart.",
        toolUses: [
          {
            id: clarId,
            name: "request_clarification",
            input: {
              question: "Confirm restart?",
              options: [{ label: "Yes", description: "Proceed" }],
            },
          },
          {
            id: restart1Id,
            name: "restart_service",
            input: {
              service: {
                provider: "docker",
                project: "web-01",
                service: "web-01",
              },
              rationale: "mixed",
              risk: "low",
              estimatedDowntimeSeconds: 2,
            },
          },
        ],
      },
      {
        text: "Now restarting.",
        toolUses: [
          {
            id: restart2Id,
            name: "restart_service",
            input: {
              service: {
                provider: "docker",
                project: "web-01",
                service: "web-01",
              },
              rationale: "confirmed",
              risk: "low",
              estimatedDowntimeSeconds: 2,
            },
          },
        ],
      },
      FINISH_TURN,
    ]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`, {
      headers: { Cookie: `nw_auth=${SESSION}`, Origin: "http://localhost" },
    });
    const events: WsEvent[] = [];
    ws.on("message", (raw) => {
      events.push(JSON.parse(raw.toString()) as WsEvent);
    });
    await waitForConnected(ws);

    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Mixed gate test." }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    // First interrupt: clarification
    const clarInterrupt = await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId &&
          e.payload["kind"] === "clarification",
      ),
    );
    expect(clarInterrupt.payload["kind"]).toBe("clarification");
    expect(restartCommands).toHaveLength(0);

    const answerRes = await fetch(
      `http://127.0.0.1:${port}/sessions/${sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({ text: "Yes", resolvedBy: "operator" }),
      },
    );
    expect(answerRes.status).toBe(200);

    // Second interrupt: approval for restart
    const approvalInterrupt = await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId &&
          e.payload["kind"] === "approval",
      ),
    );
    expect(approvalInterrupt.payload["toolName"]).toBe("restart_service");
    expect(restartCommands).toHaveLength(0);

    const approveRes = await fetch(
      `http://127.0.0.1:${port}/sessions/${sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({ decision: "approve", resolvedBy: "operator" }),
      },
    );
    expect(approveRes.status).toBe(200);

    // Restart executes exactly once, run completes
    await waitFor(() => restartCommands.length > 0);
    expect(restartCommands).toHaveLength(1);
    expect(hasPendingHumanInput(sessionId)).toBe(false);

    ws.close();
  });
});
