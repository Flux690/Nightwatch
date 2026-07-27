import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { RunnerCommandMessage } from "@nightwarden/shared";

vi.mock("../llm/factory.js", () => import("./llm-factory-mock.js"));

import { mockCreateProvider } from "./llm-factory-mock.js";

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
import { registerConsoleEventRoutes } from "../session/events.js";
import {
  connectConsoleEvents,
  toolCallReached,
} from "./console-events-helper.js";
import { registerSessionRoutes } from "../session/routes.js";
import {
  registerRunner,
  setRunnerManifest,
  unregisterRunner,
} from "../ws/fleet.js";
import type { RunnerConnection } from "../ws/fleet.js";
import { resolveCommand } from "../ws/command-transport.js";
import { insertPendingHumanInput } from "../db/interrupts.js";
import {
  findRemediationAction,
  insertRejectedRemediationAction,
} from "../db/remediation-actions.js";
import { getDb } from "../db/client.js";
import { mountApi } from "./api-server.js";

const FINISH_TURN = { text: "Done.", toolUses: [] };

describe("remediation action record", () => {
  let server: FastifyInstance;
  let port: number;
  let cleanupDb: () => void;
  let SESSION: string;
  let TEST_TOKEN: string;
  let conn: RunnerConnection;
  const restartCommands: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();
    TEST_TOKEN = generateRunnerToken("remediation-007").id;

    conn = registerRunner(
      TEST_TOKEN,
      (raw: string) => {
        const msg = JSON.parse(raw) as RunnerCommandMessage;
        const { commandName, commandInput, correlationId } = msg.payload;
        if (commandName === "RestartDockerService") {
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
        postgres: { available: false },
        redis: { available: false },
        hostMetrics: true,
        fileRead: true,
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

  it("approve: inserts remediation_actions row with executed status and correct service identity key", async () => {
    restartCommands.length = 0;
    const toolUseId = "tu-ra-approve-1";

    setScript([
      {
        text: "Restarting.",
        toolUses: [
          {
            id: toolUseId,
            name: "RestartDockerService",
            input: {
              target: "docker/svc-01/api",
              rationale: "crash loop",
              risk: "low",
              estimatedDowntimeSeconds: 3,
            },
          },
        ],
      },
      FINISH_TURN,
    ]);

    const { events, close } = await connectConsoleEvents(port, SESSION);

    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
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
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`,
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

    const row = findRemediationAction(sessionId, toolUseId);
    expect(row).toBeDefined();
    expect(row!.status).toBe("executed");
    expect(row!.toolName).toBe("RestartDockerService");
    expect(row!.sessionId).toBe(sessionId);
    expect(row!.serviceIdentityKey).toBe("docker/svc-01/api");
    expect(row!.resolvedBy).toBe("operator");
    expect(row!.resolvedAt).toBeTruthy();

    close();
  });

  it("reject: inserts remediation_actions row with rejected status", async () => {
    const toolUseId = "tu-ra-reject-1";

    setScript([
      {
        text: "Restarting.",
        toolUses: [
          {
            id: toolUseId,
            name: "RestartDockerService",
            input: {
              target: "docker/svc-01/api",
              rationale: "crash loop",
              risk: "high",
              estimatedDowntimeSeconds: 5,
            },
          },
        ],
      },
      FINISH_TURN,
    ]);

    const { events, close } = await connectConsoleEvents(port, SESSION);

    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
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
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`,
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

    const row = findRemediationAction(sessionId, toolUseId);
    expect(row).toBeDefined();
    expect(row!.status).toBe("rejected");
    expect(row!.sessionId).toBe(sessionId);
    expect(row!.serviceIdentityKey).toBe("docker/svc-01/api");
    expect(row!.resolvedBy).toBe("operator");

    close();
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
      toolName: "RestartDockerService",
      toolInput: {
        target: "docker/svc-01/api",
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
         VALUES (?, ?, 'RestartDockerService', 'docker/svc-01/api', 'executing', '{}', ?)`,
      )
      .run(toolUseId, sessionId, new Date().toISOString());

    // LLM resumes with a single finish turn (no further tool calls)
    setScript([FINISH_TURN]);

    const { events, close } = await connectConsoleEvents(port, SESSION);

    // Approve — should detect the conflict and skip execution
    const approveRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`,
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
    const row = findRemediationAction(sessionId, toolUseId);
    expect(row!.status).toBe("executing");

    close();
  });

  it("reject: re-rejecting an already-recorded action is idempotent", () => {
    const toolUseId = "tu-ra-reject-idem-1";
    const sessionId = randomUUID();

    getDb()
      .prepare(
        `INSERT INTO sessions (session_id, title, created_at) VALUES (?, 'test', ?)`,
      )
      .run(sessionId, new Date().toISOString());

    const params = {
      toolUseId,
      sessionId,
      toolName: "RestartDockerService",
      input: {
        target: "docker/svc-01/api",
        rationale: "crash",
        risk: "low",
        estimatedDowntimeSeconds: 2,
      },
      resolvedBy: "operator",
    };

    expect(insertRejectedRemediationAction(params)).toBe(true);
    // Second call: idempotent — no throw, no double-insert
    expect(insertRejectedRemediationAction(params)).toBe(false);

    // Only one row for this (sessionId, toolUseId)
    const count = getDb()
      .prepare(
        `SELECT COUNT(*) AS c FROM remediation_actions WHERE session_id = ? AND tool_use_id = ?`,
      )
      .get(sessionId, toolUseId) as { c: number };
    expect(count.c).toBe(1);
  });

  it("composite key: same tool_use_id in different sessions does not conflict", () => {
    const toolUseId = "tu-ra-cross-session-1";
    const sessionId1 = randomUUID();
    const sessionId2 = randomUUID();

    getDb()
      .prepare(
        `INSERT INTO sessions (session_id, title, created_at) VALUES (?, 'test', ?)`,
      )
      .run(sessionId1, new Date().toISOString());
    getDb()
      .prepare(
        `INSERT INTO sessions (session_id, title, created_at) VALUES (?, 'test', ?)`,
      )
      .run(sessionId2, new Date().toISOString());

    const baseParams = {
      toolUseId,
      toolName: "RestartDockerService",
      input: {
        target: "docker/svc-01/api",
        rationale: "cross-session test",
        risk: "low",
        estimatedDowntimeSeconds: 2,
      },
      resolvedBy: "operator",
    };

    expect(() =>
      insertRejectedRemediationAction({ ...baseParams, sessionId: sessionId1 }),
    ).not.toThrow();
    expect(() =>
      insertRejectedRemediationAction({ ...baseParams, sessionId: sessionId2 }),
    ).not.toThrow();

    expect(findRemediationAction(sessionId1, toolUseId)?.status).toBe(
      "rejected",
    );
    expect(findRemediationAction(sessionId2, toolUseId)?.status).toBe(
      "rejected",
    );
  });

  it("reads are not recorded in remediation_actions", async () => {
    const toolUseId = "tu-ra-read-1";

    setScript([
      {
        text: "Checking logs.",
        toolUses: [
          {
            id: toolUseId,
            name: "ListDockerServices",
            input: {},
          },
        ],
      },
      FINISH_TURN,
    ]);

    const { events, close } = await connectConsoleEvents(port, SESSION);

    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "What containers are running?" }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    // Wait for the read tool's card to complete: no interrupt on this path.
    await waitFor(() => toolCallReached(events, toolUseId, "complete"));

    // No record in remediation_actions for this tool_use_id
    expect(findRemediationAction(sessionId, toolUseId)).toBeUndefined();

    close();
  });
});
