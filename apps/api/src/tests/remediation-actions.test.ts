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

import { generateToken } from "../db/tokens.js";
import { useTempDb } from "./temp-db.js";
import { mintTestSession } from "./session-helper.js";
import { waitFor } from "./wait.js";
import { registerConsoleWsRoutes } from "../ws/console.js";
import { registerSessionRoutes } from "../session/routes.js";
import {
  registerRunner,
  setRunnerManifest,
  unregisterRunner,
  resolveCommand,
} from "../ws/router.js";
import { insertPendingHumanInput } from "../db/interrupts.js";
import { findRemediationAction } from "../db/remediation-actions.js";
import { getDb } from "../db/client.js";

interface WsEvent {
  type: string;
  payload: Record<string, unknown>;
}

const FINISH_TURN = { text: "Done.", toolUses: [] };

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

describe("remediation action record", () => {
  let server: FastifyInstance;
  let port: number;
  let cleanupDb: () => void;
  let SESSION: string;
  let TEST_TOKEN: string;
  const TEST_RUNNER_ID = "runner-remediation-007";
  const restartCommands: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();
    TEST_TOKEN = generateToken("remediation-007").id;

    registerRunner(
      TEST_TOKEN,
      (raw: string) => {
        const msg = JSON.parse(raw) as RunnerCommandMessage;
        const { commandName, commandInput, correlationId } = msg.payload;
        if (commandName === "restart_container") {
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
      hostname: "remediation-host",
      runnerVersion: "2.0.0",
      capabilities: {
        docker: true,
        kubernetes: false,
        services: [
          {
            identity: { provider: "docker", project: "svc-01", service: "api" },
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

  it("approve: inserts remediation_actions row with executed status and correct service identity key", async () => {
    restartCommands.length = 0;
    const toolUseId = "tu-ra-approve-1";

    setScript([
      {
        text: "Restarting.",
        toolUses: [
          {
            id: toolUseId,
            name: "restart_service",
            input: {
              service: {
                provider: "docker",
                project: "svc-01",
                service: "api",
              },
              rationale: "crash loop",
              risk: "low",
              estimatedDowntimeSeconds: 3,
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
    ws.on("message", (raw) =>
      events.push(JSON.parse(raw.toString()) as WsEvent),
    );
    await waitForConnected(ws);

    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Pod keeps restarting." }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );

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

    await waitFor(() =>
      events.some(
        (e) =>
          e.type === "HUMAN_INPUT_RESOLVED" &&
          e.payload["toolUseId"] === toolUseId,
      ),
    );

    const row = findRemediationAction(toolUseId);
    expect(row).toBeDefined();
    expect(row!.status).toBe("executed");
    expect(row!.toolName).toBe("restart_service");
    expect(row!.sessionId).toBe(sessionId);
    expect(row!.serviceIdentityKey).toBe("docker/svc-01/api");
    expect(row!.resolvedBy).toBe("operator");
    expect(row!.resolvedAt).toBeTruthy();

    ws.close();
  });

  it("reject: inserts remediation_actions row with rejected status", async () => {
    const toolUseId = "tu-ra-reject-1";

    setScript([
      {
        text: "Restarting.",
        toolUses: [
          {
            id: toolUseId,
            name: "restart_service",
            input: {
              service: {
                provider: "docker",
                project: "svc-01",
                service: "api",
              },
              rationale: "crash loop",
              risk: "high",
              estimatedDowntimeSeconds: 5,
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
    ws.on("message", (raw) =>
      events.push(JSON.parse(raw.toString()) as WsEvent),
    );
    await waitForConnected(ws);

    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Pod keeps restarting." }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

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
          resolvedBy: "operator",
        }),
      },
    );
    expect(rejectRes.status).toBe(200);

    await waitFor(() =>
      events.some(
        (e) =>
          e.type === "HUMAN_INPUT_RESOLVED" &&
          e.payload["status"] === "rejected",
      ),
    );

    const row = findRemediationAction(toolUseId);
    expect(row).toBeDefined();
    expect(row!.status).toBe("rejected");
    expect(row!.sessionId).toBe(sessionId);
    expect(row!.serviceIdentityKey).toBe("docker/svc-01/api");
    expect(row!.resolvedBy).toBe("operator");

    ws.close();
  });

  it("at-most-once: pre-existing executing row for same tool_use_id skips execution", async () => {
    restartCommands.length = 0;
    const toolUseId = "tu-ra-amo-1";
    const sessionId = randomUUID();

    // Seed the session and pending interrupt rows (simulates post-crash state)
    getDb()
      .prepare(
        `INSERT INTO sessions (session_id, title, created_at) VALUES (?, 'test', ?)`,
      )
      .run(sessionId, new Date().toISOString());

    insertPendingHumanInput({
      sessionId,
      toolUseId,
      kind: "approval",
      toolName: "restart_container",
      toolInput: {
        service: { provider: "docker", project: "svc-01", service: "api" },
        rationale: "wedged",
        risk: "low",
        estimatedDowntimeSeconds: 2,
      },
      completedResults: [],
      claimedAt: null,
      createdAt: new Date().toISOString(),
    });

    // Simulate the write-ahead row that was inserted before the API crashed
    getDb()
      .prepare(
        `INSERT INTO remediation_actions
           (tool_use_id, session_id, tool_name, service_identity_key, status, input, created_at)
         VALUES (?, ?, 'restart_container', 'docker/svc-01/api', 'executing', '{}', ?)`,
      )
      .run(toolUseId, sessionId, new Date().toISOString());

    // LLM resumes with a single finish turn (no further tool calls)
    setScript([FINISH_TURN]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`, {
      headers: { Cookie: `nw_auth=${SESSION}`, Origin: "http://localhost" },
    });
    const events: WsEvent[] = [];
    ws.on("message", (raw) =>
      events.push(JSON.parse(raw.toString()) as WsEvent),
    );
    await waitForConnected(ws);

    // Approve — should detect the conflict and skip execution
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

    await waitFor(() =>
      events.some(
        (e) =>
          e.type === "HUMAN_INPUT_RESOLVED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );

    // Runner must NOT have received any command
    expect(restartCommands).toHaveLength(0);

    // The remediation_actions row still has 'executing' (crash outcome unknown)
    const row = findRemediationAction(toolUseId);
    expect(row!.status).toBe("executing");

    ws.close();
  });

  it("reads are not recorded in remediation_actions", async () => {
    const toolUseId = "tu-ra-read-1";

    setScript([
      {
        text: "Checking logs.",
        toolUses: [
          {
            id: toolUseId,
            name: "list_services",
            input: { environment: "docker" },
          },
        ],
      },
      FINISH_TURN,
    ]);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`, {
      headers: { Cookie: `nw_auth=${SESSION}`, Origin: "http://localhost" },
    });
    const events: WsEvent[] = [];
    ws.on("message", (raw) =>
      events.push(JSON.parse(raw.toString()) as WsEvent),
    );
    await waitForConnected(ws);

    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "What containers are running?" }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    // Wait for run to finish (no interrupt, just tool call end + run finished)
    await waitFor(() =>
      events.some(
        (e) =>
          e.type === "TOOL_CALL_END" && e.payload["toolUseId"] === toolUseId,
      ),
    );

    // No record in remediation_actions for this tool_use_id
    expect(findRemediationAction(toolUseId)).toBeUndefined();

    ws.close();
  });
});
