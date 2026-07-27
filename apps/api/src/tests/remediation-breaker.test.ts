import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type {
  RunnerCommandMessage,
  RemediationStatus,
} from "@nightwarden/shared";

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
  type ConsoleEventFrame,
} from "./console-events-helper.js";
import { registerSessionRoutes } from "../session/routes.js";
import { hasPendingHumanInput } from "../db/interrupts.js";
import { getSessionMessages } from "../db/sessions.js";
import { updateConfig } from "../config/store.js";
import {
  registerRunner,
  setRunnerManifest,
  unregisterRunner,
} from "../ws/fleet.js";
import type { RunnerConnection } from "../ws/fleet.js";
import { resolveCommand } from "../ws/command-transport.js";
import { getDb } from "../db/client.js";
import { mountApi } from "./api-server.js";

const FINISH_TURN: ScriptedTurn = {
  text: "Investigation complete.",
  toolUses: [],
};

const DEFAULT_LIMIT = 5;
const DEFAULT_WINDOW_MS = 600_000;

// A pre-existing session the seeded prior remediation actions hang off, so the
// breaker counts a storm that spans sessions, not just the live one.
const PRIOR_SESSION = "prior-session-breaker";

function seedRemediations(params: {
  serviceIdentityKey: string;
  toolName: string;
  status: RemediationStatus;
  count: number;
  createdAt?: string;
}): void {
  const stmt = getDb().prepare(
    `INSERT INTO remediation_actions
       (tool_use_id, session_id, tool_name, service_identity_key, status, input, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, '{}', ?, ?)`,
  );
  const now = new Date().toISOString();
  for (let i = 0; i < params.count; i++) {
    stmt.run(
      randomUUID(),
      PRIOR_SESSION,
      params.toolName,
      params.serviceIdentityKey,
      params.status,
      params.createdAt ?? now,
      now,
    );
  }
}

describe("remediation circuit breaker", () => {
  let server: FastifyInstance;
  let port: number;
  let cleanupDb: () => void;
  let SESSION: string;
  let TEST_TOKEN: string;
  let conn: RunnerConnection;
  const executedCommands: string[] = [];

  function restartWrite(target: string): ScriptedTurn {
    return {
      text: "Restarting service.",
      toolUses: [
        {
          id: `tu-${randomUUID()}`,
          name: "RestartDockerService",
          input: {
            target,
            rationale: "crash loop",
            risk: "low",
            estimatedDowntimeSeconds: 2,
          },
        },
      ],
    };
  }

  // Streams opened by runChat are closed in afterAll: an open SSE stream is an
  // active request, and leaving one behind would stall server.close().
  const openStreams: Array<() => void> = [];

  async function runChat(): Promise<{
    sessionId: string;
    events: ConsoleEventFrame[];
  }> {
    const { events, close } = await connectConsoleEvents(port, SESSION);
    openStreams.push(close);

    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Fix the service." }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };
    return { sessionId, events };
  }

  // Asserts the run was refused by the breaker: it finished without suspending,
  // the runner was never called, and the model got the corrective tool_result.
  async function expectBreakerRefused(
    sessionId: string,
    events: ConsoleEventFrame[],
  ): Promise<void> {
    await waitFor(() =>
      events.some((e) => {
        if (e.type !== "MESSAGE") return false;
        const message = e.payload["message"] as { content?: string };
        return message.content === "Investigation complete.";
      }),
    );
    expect(
      events.some(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    ).toBe(false);
    expect(hasPendingHumanInput(sessionId)).toBe(false);
    expect(executedCommands).not.toContain("RestartDockerService");

    const corrective = getSessionMessages(sessionId).find(
      (m) =>
        m.role === "user" &&
        m.content.includes("Circuit breaker") &&
        m.content.includes("RestartDockerService"),
    );
    expect(corrective).toBeDefined();
  }

  // Asserts the write suspended for an approval card (breaker did not trip),
  // then rejects it to release the interrupt for the next test.
  async function expectApprovalThenReject(
    sessionId: string,
    events: ConsoleEventFrame[],
  ): Promise<void> {
    const interrupt = await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );
    expect(interrupt.payload["kind"]).toBe("approval");
    expect(interrupt.payload["toolName"]).toBe("RestartDockerService");
    expect(executedCommands).not.toContain("RestartDockerService");

    await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ decision: "reject", resolvedBy: "cleanup" }),
    });
    await waitFor(() => !hasPendingHumanInput(sessionId));
  }

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();
    TEST_TOKEN = generateRunnerToken("breaker-008").id;

    getDb()
      .prepare(
        `INSERT INTO sessions (session_id, title, created_at) VALUES (?, 'prior', ?)`,
      )
      .run(PRIOR_SESSION, new Date().toISOString());

    conn = registerRunner(
      TEST_TOKEN,
      (raw: string) => {
        const msg = JSON.parse(raw) as RunnerCommandMessage;
        const { commandName, correlationId } = msg.payload;
        executedCommands.push(commandName);
        resolveCommand({
          correlationId,
          success: true,
          result: { restarted: true },
        });
      },
      () => {},
    );
    setRunnerManifest(TEST_TOKEN, {
      hostname: "breaker-host",
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

  beforeEach(() => {
    executedCommands.length = 0;
    updateConfig({
      remediationBreakerLimit: DEFAULT_LIMIT,
      remediationBreakerWindowMs: DEFAULT_WINDOW_MS,
    });
  });

  afterAll(async () => {
    for (const close of openStreams) close();
    unregisterRunner(conn);
    await server.close();
    cleanupDb();
    vi.unstubAllEnvs();
  });

  it("refuses a write past the limit with a corrective tool_result and raises no approval card", async () => {
    const target = "docker/svc-01/api";
    seedRemediations({
      serviceIdentityKey: "docker/svc-01/api",
      toolName: "RestartDockerService",
      status: "executed",
      count: DEFAULT_LIMIT,
    });

    setScript([restartWrite(target), FINISH_TURN]);
    const { sessionId, events } = await runChat();

    await expectBreakerRefused(sessionId, events);
  });

  it("suspends for approval when writes are under the limit", async () => {
    const target = "docker/svc-01/web";
    seedRemediations({
      serviceIdentityKey: "docker/svc-01/web",
      toolName: "RestartDockerService",
      status: "executed",
      count: DEFAULT_LIMIT - 1,
    });

    setScript([restartWrite(target), FINISH_TURN]);
    const { sessionId, events } = await runChat();

    await expectApprovalThenReject(sessionId, events);
  });

  it("does not count failed writes toward the limit (a transient failure must not lock out retries)", async () => {
    const target = "docker/svc-01/cache";
    // None of these failed writes actually landed, so the breaker must not trip - a runner blip
    // can't burn the budget and block a retry of an action that never ran.
    seedRemediations({
      serviceIdentityKey: "docker/svc-01/cache",
      toolName: "RestartDockerService",
      status: "failed",
      count: DEFAULT_LIMIT,
    });

    setScript([restartWrite(target), FINISH_TURN]);
    const { sessionId, events } = await runChat();

    await expectApprovalThenReject(sessionId, events);
  });

  it("ignores rejected and still-executing rows when counting", async () => {
    const target = "docker/svc-01/queue";
    // Far past the limit, but none are landed writes: a rejection never ran and
    // an 'executing' row is a crash with unknown outcome.
    seedRemediations({
      serviceIdentityKey: "docker/svc-01/queue",
      toolName: "RestartDockerService",
      status: "rejected",
      count: DEFAULT_LIMIT * 2,
    });
    seedRemediations({
      serviceIdentityKey: "docker/svc-01/queue",
      toolName: "RestartDockerService",
      status: "executing",
      count: DEFAULT_LIMIT * 2,
    });

    setScript([restartWrite(target), FINISH_TURN]);
    const { sessionId, events } = await runChat();

    await expectApprovalThenReject(sessionId, events);
  });

  it("keys the count on the service identity: a storm on another service does not trip", async () => {
    // The limit is reached for a different service, and for a different action
    // on the target service - neither should count against this write.
    seedRemediations({
      serviceIdentityKey: "docker/svc-01/other",
      toolName: "RestartDockerService",
      status: "executed",
      count: DEFAULT_LIMIT,
    });
    seedRemediations({
      serviceIdentityKey: "docker/svc-01/worker",
      toolName: "DockerBash",
      status: "executed",
      count: DEFAULT_LIMIT,
    });

    const target = "docker/svc-01/worker";
    setScript([restartWrite(target), FINISH_TURN]);
    const { sessionId, events } = await runChat();

    await expectApprovalThenReject(sessionId, events);
  });

  it("honours a configured threshold lower than the default", async () => {
    updateConfig({ remediationBreakerLimit: 2 });
    const target = "docker/svc-01/db";
    seedRemediations({
      serviceIdentityKey: "docker/svc-01/db",
      toolName: "RestartDockerService",
      status: "executed",
      count: 2,
    });

    setScript([restartWrite(target), FINISH_TURN]);
    const { sessionId, events } = await runChat();

    await expectBreakerRefused(sessionId, events);
  });

  it("only counts writes inside the configured window", async () => {
    const target = "docker/svc-01/mail";
    const beforeWindow = new Date(
      Date.now() - (DEFAULT_WINDOW_MS + 60_000),
    ).toISOString();
    // Far past the limit, but all older than the window - so none count.
    seedRemediations({
      serviceIdentityKey: "docker/svc-01/mail",
      toolName: "RestartDockerService",
      status: "executed",
      count: DEFAULT_LIMIT * 2,
      createdAt: beforeWindow,
    });

    setScript([restartWrite(target), FINISH_TURN]);
    const { sessionId, events } = await runChat();

    await expectApprovalThenReject(sessionId, events);
  });
});
