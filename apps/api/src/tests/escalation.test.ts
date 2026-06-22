import "dotenv/config";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import Fastify from "fastify";
import FastifyWebSocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { NormalizedAlert, RunnerCommandMessage } from "@nightwatch/shared";

import {
  createContractFakeProvider,
  type ScriptedTurn,
} from "./contract-fake-provider.js";

const { mockCreateProvider } = vi.hoisted(() => ({
  mockCreateProvider: vi.fn(),
}));

vi.mock("../llm/factory.js", () => ({ createProvider: mockCreateProvider }));

import { generateToken } from "../db/tokens.js";
import { useTempDb } from "./temp-db.js";
import { mintTestSession } from "./session-helper.js";
import { waitFor } from "./wait.js";
import { registerConsoleWsRoutes } from "../ws/console.js";

import { registerSessionRoutes } from "../session/routes.js";
import { dispatcher } from "../dispatcher.js";
import { getSessionMessages } from "../db/sessions.js";
import { updateConfig } from "../config/store.js";
import {
  registerRunner,
  setRunnerManifest,
  unregisterRunner,
  resolveCommand,
} from "../ws/router.js";

interface WsEvent {
  type: string;
  payload: Record<string, unknown>;
}

function waitForConnected(ws: WebSocket): Promise<void> {
  return new Promise<void>((resolve) => {
    const onMessage = (raw: WebSocket.RawData): void => {
      const msg = JSON.parse(raw.toString()) as WsEvent;
      if (msg.type === "connected") {
        ws.off("message", onMessage);
        resolve();
      }
    };
    ws.on("message", onMessage);
  });
}

describe("termination paths: every run ends in model text, no escalation", () => {
  let server: FastifyInstance;
  let port: number;
  let cleanupDb: () => void;
  let TEST_TOKEN: string;
  let SESSION: string;
  const TEST_RUNNER_ID = "test-runner-esc";

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();
    TEST_TOKEN = generateToken("test-esc-runner").id;

    registerRunner(
      TEST_TOKEN,
      (raw: string) => {
        const msg = JSON.parse(raw) as RunnerCommandMessage;
        const { correlationId } = msg.payload;
        resolveCommand({ correlationId, success: true, result: [] });
      },
      () => {},
    );
    setRunnerManifest(TEST_TOKEN, {
      runnerId: TEST_RUNNER_ID,
      hostname: "esc-host",
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

  it("model refusal ends on model's own text: no synthetic message, no ESCALATED", async () => {
    const refusalScript: ScriptedTurn[] = [
      { toolUses: [], text: "I cannot help with that.", stopReason: "refusal" },
    ];
    mockCreateProvider.mockImplementationOnce(() =>
      createContractFakeProvider(refusalScript),
    );

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`, {
      headers: { Cookie: `nw_auth=${SESSION}`, Origin: "http://localhost" },
    });
    await waitForConnected(ws);

    const events: WsEvent[] = [];
    ws.on("message", (raw) => {
      events.push(JSON.parse(raw.toString()) as WsEvent);
    });

    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Do something dangerous." }),
    });
    expect(res.status).toBe(202);
    const { sessionId } = (await res.json()) as { sessionId: string };

    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "RUN_FINISHED" &&
          e.payload["sessionId"] === sessionId &&
          (e.payload["message"] as { role?: string } | undefined)?.role ===
            "assistant",
      ),
    );
    ws.close();

    const messages = getSessionMessages(sessionId);
    const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
    expect(lastAssistant?.content).toBe("I cannot help with that.");
    expect(
      messages.some((m) => m.content.startsWith("Escalated to human:")),
    ).toBe(false);
    expect(events.some((e) => e.type === "ESCALATED")).toBe(false);
  });

  it("free-form text finish: model text is the answer, no escalation", async () => {
    const finishScript: ScriptedTurn[] = [
      { toolUses: [], text: "Root cause found. I am done." },
    ];
    mockCreateProvider.mockImplementationOnce(() =>
      createContractFakeProvider(finishScript),
    );

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`, {
      headers: { Cookie: `nw_auth=${SESSION}`, Origin: "http://localhost" },
    });
    await waitForConnected(ws);

    const events: WsEvent[] = [];
    ws.on("message", (raw) => {
      events.push(JSON.parse(raw.toString()) as WsEvent);
    });

    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Wrap up." }),
    });
    expect(res.status).toBe(202);
    const { sessionId } = (await res.json()) as { sessionId: string };

    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "RUN_FINISHED" &&
          e.payload["sessionId"] === sessionId &&
          (
            e.payload["message"] as
              | { role?: string; content?: string }
              | undefined
          )?.content === "Root cause found. I am done.",
      ),
    );
    ws.close();

    const messages = getSessionMessages(sessionId);
    const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
    expect(lastAssistant?.content).toBe("Root cause found. I am done.");
    expect(
      messages.some((m) => m.content.startsWith("Escalated to human:")),
    ).toBe(false);
    expect(events.some((e) => e.type === "ESCALATED")).toBe(false);
  });

  it("critical rejection resumes with coherent transcript: no escalation, model continues", async () => {
    const toolUseId = `tu-crit-${randomUUID()}`;

    const firstRunScript: ScriptedTurn[] = [
      {
        toolUses: [
          {
            id: toolUseId,
            name: "restart_container",
            input: {
              service: {
                provider: "docker",
                project: "web-01",
                service: "web-01",
              },
            },
          },
        ],
        text: "Need to restart.",
      },
    ];
    const resumeScript: ScriptedTurn[] = [
      {
        toolUses: [],
        text: "Understood. The restart was rejected. Here is my analysis.",
      },
    ];
    mockCreateProvider
      .mockImplementationOnce(() => createContractFakeProvider(firstRunScript))
      .mockImplementationOnce(() => createContractFakeProvider(resumeScript));

    const sessionId = randomUUID();
    const alert: NormalizedAlert = {
      sourceAlertId: `crit-${randomUUID()}`,
      runnerId: TEST_RUNNER_ID,
      targetIdentifier: {
        provider: "docker",
        project: "web-01",
        service: "web-01",
      },
      alertType: "ContainerDown",
      severity: "critical",
      firedAt: new Date().toISOString(),
      rawPayload: {},
    };

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`, {
      headers: { Cookie: `nw_auth=${SESSION}`, Origin: "http://localhost" },
    });
    await waitForConnected(ws);

    const events: WsEvent[] = [];
    ws.on("message", (raw) => {
      events.push(JSON.parse(raw.toString()) as WsEvent);
    });

    dispatcher.dispatch({ alert, sessionId });

    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );

    const rejectRes = await fetch(
      `http://127.0.0.1:${port}/sessions/${sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({
          decision: "reject",
          text: "too risky",
          resolvedBy: "test",
        }),
      },
    );
    expect(rejectRes.status).toBe(200);

    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "RUN_FINISHED" &&
          e.payload["sessionId"] === sessionId &&
          (
            e.payload["message"] as
              | { role?: string; content?: string }
              | undefined
          )?.content ===
            "Understood. The restart was rejected. Here is my analysis.",
      ),
    );
    ws.close();

    const messages = getSessionMessages(sessionId);
    expect(
      messages.some((m) => m.content.startsWith("Escalated to human:")),
    ).toBe(false);
    expect(events.some((e) => e.type === "ESCALATED")).toBe(false);

    const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
    expect(lastAssistant?.content).toContain("rejected");
  });

  it("budget exhaustion runs wrap-up turn: model text ends the run, no escalation", async () => {
    updateConfig({ maxToolCalls: 3 });

    const budgetScript: ScriptedTurn[] = [
      {
        toolUses: [
          {
            id: "tu-b1",
            name: "get_container_list",
            input: { environment: "docker" },
          },
        ],
        text: "",
      },
      {
        toolUses: [
          {
            id: "tu-b2",
            name: "get_container_list",
            input: { environment: "docker" },
          },
        ],
        text: "",
      },
      {
        toolUses: [
          {
            id: "tu-b3",
            name: "get_container_list",
            input: { environment: "docker" },
          },
        ],
        text: "",
      },
      { toolUses: [], text: "Budget reached. Here is what I found so far." },
    ];
    mockCreateProvider.mockImplementationOnce(() =>
      createContractFakeProvider(budgetScript),
    );

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`, {
      headers: { Cookie: `nw_auth=${SESSION}`, Origin: "http://localhost" },
    });
    await waitForConnected(ws);

    const events: WsEvent[] = [];
    ws.on("message", (raw) => {
      events.push(JSON.parse(raw.toString()) as WsEvent);
    });

    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Investigate forever." }),
    });
    expect(res.status).toBe(202);
    const { sessionId } = (await res.json()) as { sessionId: string };

    await waitFor(
      () =>
        events.find(
          (e) =>
            e.type === "RUN_FINISHED" &&
            e.payload["sessionId"] === sessionId &&
            (
              e.payload["message"] as
                | { role?: string; content?: string }
                | undefined
            )?.content === "Budget reached. Here is what I found so far.",
        ),
      { timeout: 15_000 },
    );
    ws.close();

    const messages = getSessionMessages(sessionId);
    const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
    expect(lastAssistant?.content).toBe(
      "Budget reached. Here is what I found so far.",
    );
    expect(
      messages.some((m) => m.content.startsWith("Escalated to human:")),
    ).toBe(false);
    expect(events.some((e) => e.type === "ESCALATED")).toBe(false);
  });
});
