import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { vi } from "vitest";
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
import { connectConsoleEvents } from "./console-events-helper.js";
import { registerSessionRoutes } from "../session/routes.js";
import { hasPendingHumanInput } from "../db/interrupts.js";
import {
  registerRunner,
  setRunnerManifest,
  unregisterRunner,
} from "../ws/fleet.js";
import type { RunnerConnection } from "../ws/fleet.js";
import { resolveCommand } from "../ws/command-transport.js";

const CLARIFICATION_OPTIONS = [
  { label: "Memory pressure", description: "OOM conditions observed" },
  {
    label: "Deploy regression",
    description: "Recent deploy introduced the issue",
  },
];

describe("access-gate: gating is driven by tool access level", () => {
  let server: FastifyInstance;
  let port: number;
  let cleanupDb: () => void;
  let TEST_TOKEN: string;
  let conn: RunnerConnection;
  let SESSION: string;
  const executedCommands: string[] = [];

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();
    TEST_TOKEN = generateRunnerToken("access-gate-001").id;

    conn = registerRunner(
      TEST_TOKEN,
      (raw: string) => {
        const msg = JSON.parse(raw) as RunnerCommandMessage;
        const { commandName, correlationId } = msg.payload;
        executedCommands.push(commandName);
        resolveCommand({
          correlationId,
          success: true,
          result:
            commandName === "RestartDockerService" ? { restarted: true } : [],
        });
      },
      () => {},
    );
    setRunnerManifest(TEST_TOKEN, {
      hostname: "access-gate-host",
      runnerVersion: "2.0.0",
      capabilities: {
        docker: true,
        kubernetes: false,
        services: [
          {
            identity: {
              provider: "docker",
              project: "svc-01",
              service: "svc-01",
            },
            status: "running",
          },
        ],
        postgres: { available: false },
        redis: { available: false },
        hostMetrics: true,
        fileRead: true,
        remediationEnabled: true,
      },
    });

    server = Fastify({ logger: false, forceCloseConnections: true });
    await registerConsoleEventRoutes(server);
    await registerSessionRoutes(server);
    await server.listen({ port: 0, host: "127.0.0.1" });
    port = (server.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    unregisterRunner(conn);
    await server.close();
    cleanupDb();
    vi.unstubAllEnvs();
  });

  it("read tool executes without suspending: TOOL_CALL_END arrives, no HUMAN_INPUT_REQUIRED", async () => {
    setScript([
      {
        text: "Listing containers.",
        toolUses: [
          {
            id: "tu-read-1",
            name: "ListDockerServices",
            input: {},
          },
        ],
      },
      { text: "Investigation complete.", toolUses: [] },
    ]);

    const { events, close } = await connectConsoleEvents(port, SESSION);

    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "List containers." }),
    });
    expect(res.status).toBe(202);
    const { sessionId } = (await res.json()) as { sessionId: string };

    // Read tool must emit TOOL_CALL_END without any suspension
    await waitFor(() =>
      events.some(
        (e) =>
          e.type === "TOOL_CALL_END" && e.payload["toolUseId"] === "tu-read-1",
      ),
    );

    // No suspension must have occurred
    expect(
      events.some(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    ).toBe(false);

    expect(hasPendingHumanInput(sessionId)).toBe(false);

    close();
  });

  it("write tool suspends with approval card: HUMAN_INPUT_REQUIRED kind=approval, runner not called", async () => {
    executedCommands.length = 0;

    setScript([
      {
        text: "Restarting service.",
        toolUses: [
          {
            id: "tu-write-1",
            name: "RestartDockerService",
            input: {
              target: "docker/svc-01/svc-01",
              rationale: "service wedged",
              risk: "low",
              estimatedDowntimeSeconds: 2,
            },
          },
        ],
      },
      { text: "Done.", toolUses: [] },
    ]);

    const { events, close } = await connectConsoleEvents(port, SESSION);

    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Restart the service." }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    const interrupt = await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );

    expect(interrupt.payload["kind"]).toBe("approval");
    expect(interrupt.payload["toolName"]).toBe("RestartDockerService");

    // Runner must NOT have executed the write yet
    expect(executedCommands).not.toContain("RestartDockerService");
    expect(hasPendingHumanInput(sessionId)).toBe(true);

    close();

    // cleanup
    await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/respond`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ decision: "reject", resolvedBy: "cleanup" }),
    });
    await waitFor(() => !hasPendingHumanInput(sessionId));
  });

  it("ask tool suspends with clarification card: HUMAN_INPUT_REQUIRED kind=clarification, question+options forwarded", async () => {
    setScript([
      {
        text: "Asking for clarification.",
        toolUses: [
          {
            id: "tu-ask-1",
            name: "AskUserQuestion",
            input: {
              question: "What is the most likely root cause?",
              options: CLARIFICATION_OPTIONS,
            },
          },
        ],
      },
      { text: "Understood. Investigation complete.", toolUses: [] },
    ]);

    const { events, close } = await connectConsoleEvents(port, SESSION);

    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Service degraded." }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    const interrupt = await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );

    expect(interrupt.payload["kind"]).toBe("clarification");
    expect(interrupt.payload["question"]).toBe(
      "What is the most likely root cause?",
    );
    expect(interrupt.payload["options"]).toEqual(CLARIFICATION_OPTIONS);
    expect(hasPendingHumanInput(sessionId)).toBe(true);

    close();

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

  it("combined: read executes, ask suspends, after answer write suspends, after approval run completes", async () => {
    executedCommands.length = 0;

    setScript([
      {
        text: "Listing first.",
        toolUses: [
          {
            id: "tu-c-read",
            name: "ListDockerServices",
            input: {},
          },
        ],
      },
      {
        text: "Need more info.",
        toolUses: [
          {
            id: "tu-c-ask",
            name: "AskUserQuestion",
            input: {
              question: "Is this a recurring issue?",
              options: CLARIFICATION_OPTIONS,
            },
          },
        ],
      },
      {
        text: "Proceeding with restart.",
        toolUses: [
          {
            id: "tu-c-write",
            name: "RestartDockerService",
            input: {
              target: "docker/svc-01/svc-01",
              rationale: "confirmed by operator",
              risk: "low",
              estimatedDowntimeSeconds: 2,
            },
          },
        ],
      },
      { text: "Complete.", toolUses: [] },
    ]);

    const { events, close } = await connectConsoleEvents(port, SESSION);

    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Investigate and fix." }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    // Read tool ran without suspending
    await waitFor(() =>
      events.some(
        (e) =>
          e.type === "TOOL_CALL_END" && e.payload["toolUseId"] === "tu-c-read",
      ),
    );

    // Ask tool suspended with clarification
    const clarInterrupt = await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId &&
          e.payload["kind"] === "clarification",
      ),
    );
    expect(clarInterrupt.payload["kind"]).toBe("clarification");
    expect(executedCommands).not.toContain("RestartDockerService");

    // Answer the clarification
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
          resolvedBy: "operator",
        }),
      },
    );
    expect(answerRes.status).toBe(200);

    // Write tool suspended with approval
    const approvalInterrupt = await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId &&
          e.payload["kind"] === "approval",
      ),
    );
    expect(approvalInterrupt.payload["kind"]).toBe("approval");
    expect(approvalInterrupt.payload["toolName"]).toBe("RestartDockerService");
    expect(executedCommands).not.toContain("RestartDockerService");

    // Approve
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

    // Runner executes restart exactly once, run completes
    await waitFor(() => executedCommands.includes("RestartDockerService"));
    expect(
      executedCommands.filter((c) => c === "RestartDockerService"),
    ).toHaveLength(1);

    await waitFor(() => !hasPendingHumanInput(sessionId));
    expect(hasPendingHumanInput(sessionId)).toBe(false);

    close();
  });
});
