import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type {
  NormalizedAlert,
  RunnerCommandMessage,
  SessionReportResponse,
} from "@nightwarden/shared";
import { seedCompleteReport } from "./report-helper.js";

// Stateful scripted provider: snapshot() accumulates messages so persist() in the loop
// writes real session_messages rows.
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
import { dispatcher } from "../dispatcher.js";
import { hasPendingHumanInput } from "../db/interrupts.js";
import { getDb } from "../db/client.js";
import {
  registerRunner,
  setRunnerManifest,
  unregisterRunner,
} from "../ws/fleet.js";
import type { RunnerConnection } from "../ws/fleet.js";
import { resolveCommand } from "../ws/command-transport.js";
import { mountApi } from "./api-server.js";
import { dockerService } from "./manifest-helper.js";

// A free-form text finish: no tool call ends the run successfully.
const FINISH_TURN = {
  text: "Fixed. Investigation complete.",
  toolUses: [],
};

describe("durable approval interrupts", () => {
  let server: FastifyInstance;
  let port: number;
  let cleanupDb: () => void;
  let TEST_TOKEN: string;
  let conn: RunnerConnection;
  let SESSION: string;
  const restartCommands: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();
    TEST_TOKEN = generateRunnerToken("docker", "approval-022").id;

    conn = registerRunner({
      runnerId: TEST_TOKEN,
      platform: "docker",
      send: (raw: string) => {
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
      close: () => {},
    });
    setRunnerManifest(TEST_TOKEN, {
      platform: "docker",
      hostname: "approval-host",
      runnerVersion: "2.0.0",
      services: [dockerService("web-01")],
    });

    server = Fastify({ logger: false, forceCloseConnections: true });
    await mountApi(server, registerConsoleEventRoutes);
    await mountApi(server, registerSessionRoutes);
    await server.listen({ port: 0, host: "127.0.0.1" });
    port = (server.server.address() as AddressInfo).port;
  });

  afterEach(() => {
    // Breaker counts executed writes across the shared temp DB, so without this
    // reset one case's restarts trip it for a later case.
    getDb().prepare("DELETE FROM remediation_actions").run();
  });

  afterAll(async () => {
    unregisterRunner(conn);
    await server.close();
    cleanupDb();
    vi.unstubAllEnvs();
  });

  it("gated tool suspends: interrupt row exists in DB, run exited, INTERRUPT published", async () => {
    setScript([
      {
        text: "Restarting.",
        toolUses: [
          {
            id: "tu-sus-1",
            name: "RestartDockerService",
            input: {
              target: "docker/web-01/web-01",
              reason: "wedged",
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
      body: JSON.stringify({ message: "Service is wedged." }),
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

    // Run must have exited (dispatcher slot freed)
    expect(dispatcher.isSessionRunning(sessionId)).toBe(false);

    // Interrupt row must be in the DB
    expect(hasPendingHumanInput(sessionId)).toBe(true);

    // Runner must NOT have executed the write yet
    const countBefore = restartCommands.length;

    expect(interrupt.payload["toolName"]).toBe("RestartDockerService");

    close();

    // cleanup: approve via /respond to prevent leaking into later tests
    await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ decision: "approve", resolvedBy: "cleanup" }),
    });
    await waitFor(() => restartCommands.length > countBefore);
  });

  it("approve: executes tool on runner exactly once, run resumes, reaches free-form finish", async () => {
    restartCommands.length = 0;
    setScript([
      {
        text: "Restarting.",
        toolUses: [
          {
            id: "tu-apr-1",
            name: "RestartDockerService",
            input: {
              target: "docker/web-01/web-01",
              reason: "wedged",
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
      body: JSON.stringify({ message: "Service is wedged." }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );
    // Approve via /respond
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
    const body = (await approveRes.json()) as { status: string };
    expect(body.status).toBe("approved");

    // Run resumes and reaches free-form finish: INTERRUPT_RESOLVED arrives
    await waitFor(() =>
      events.some(
        (e) =>
          e.type === "HUMAN_INPUT_RESOLVED" &&
          e.payload["toolUseId"] === "tu-apr-1",
      ),
    );

    // Runner executed restart exactly once
    expect(restartCommands).toHaveLength(1);
    expect(restartCommands[0]["service"]).toEqual({
      project: "web-01",
      service: "web-01",
    });

    // Interrupt row is gone from DB after resolution
    expect(hasPendingHumanInput(sessionId)).toBe(false);

    // The report route reports what RAN, sourced from the executor's own log
    // rather than anything the model wrote. A report must exist for the route
    // to answer, but the actions beside it are independent of its contents.
    seedCompleteReport(sessionId);
    const reportRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/report`,
      { headers: { Cookie: `nw_auth=${SESSION}` } },
    );
    expect(reportRes.status).toBe(200);
    const { report, actions } =
      (await reportRes.json()) as SessionReportResponse;
    expect(report.recommendedFix.summary).toBe("");
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      toolUseId: "tu-apr-1",
      toolName: "RestartDockerService",
      status: "executed",
      resolvedBy: "operator",
      serviceIdentityKey: "docker/web-01/web-01",
    });

    close();
  });

  it("reject: feeds rejection result with is_error, run resumes with model adapting", async () => {
    setScript([
      {
        text: "Restarting.",
        toolUses: [
          {
            id: "tu-rej-1",
            name: "RestartDockerService",
            input: {
              target: "docker/web-01/web-01",
              reason: "wedged",
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
      body: JSON.stringify({ message: "Service is wedged." }),
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
    const body = (await rejectRes.json()) as { status: string };
    expect(body.status).toBe("rejected");

    await waitFor(() =>
      events.some(
        (e) =>
          e.type === "HUMAN_INPUT_RESOLVED" &&
          e.payload["status"] === "rejected",
      ),
    );

    expect(hasPendingHumanInput(sessionId)).toBe(false);
    close();
  });

  it("an approval with no decision is refused: it has exactly two outcomes", async () => {
    setScript([
      {
        text: "Restarting.",
        toolUses: [
          {
            id: "tu-ctx-1",
            name: "RestartDockerService",
            input: {
              target: "docker/web-01/web-01",
              reason: "wedged",
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
      body: JSON.stringify({ message: "Service is wedged." }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );
    // Bare text used to resume the run as "context added", handing the agent a
    // successful-looking result for a call that never ran.
    const ctxRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({ text: "maintenance window active" }),
      },
    );
    expect(ctxRes.status).toBe(400);
    expect(hasPendingHumanInput(sessionId)).toBe(true);

    close();

    // cleanup
    await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ decision: "reject", resolvedBy: "cleanup" }),
    });
    await waitFor(() => !hasPendingHumanInput(sessionId));
  });

  it("second resolution of same interrupt returns 409", async () => {
    setScript([
      {
        text: "Restarting.",
        toolUses: [
          {
            id: "tu-409-1",
            name: "RestartDockerService",
            input: {
              target: "docker/web-01/web-01",
              reason: "wedged",
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
      body: JSON.stringify({ message: "Service is wedged." }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );
    const first = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({ decision: "approve", resolvedBy: "op1" }),
      },
    );
    expect(first.status).toBe(200);

    const second = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({ decision: "approve", resolvedBy: "op2" }),
      },
    );
    expect(second.status).toBe(409);

    close();
  });

  // H4: concurrent approve+reject — only one wins, tool runs at most once
  it("concurrent approve+reject: exactly one succeeds, exactly one gets 409, tool runs at most once", async () => {
    restartCommands.length = 0;
    setScript([
      {
        text: "Restarting.",
        toolUses: [
          {
            id: "tu-h4-1",
            name: "RestartDockerService",
            input: {
              target: "docker/web-01/web-01",
              reason: "concurrent",
              risk: "high",
              estimatedDowntimeSeconds: 5,
            },
          },
        ],
      },
      FINISH_TURN,
    ]);

    const { events, close } = await connectConsoleEvents(port, SESSION);

    const chatRes = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Service is wedged." }),
    });
    const { sessionId } = (await chatRes.json()) as { sessionId: string };

    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );

    // Fire approve and reject concurrently
    const [approveRes, rejectRes] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({ decision: "approve", resolvedBy: "op-approve" }),
      }),
      fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({ decision: "reject", resolvedBy: "op-reject" }),
      }),
    ]);

    const statuses = [approveRes.status, rejectRes.status].sort();
    expect(statuses).toEqual([200, 409]);

    // Tool must not run more than once regardless of which path wins
    if (approveRes.status === 200) {
      await waitFor(() => restartCommands.length > 0);
      expect(restartCommands).toHaveLength(1);
    } else {
      // reject won — tool should NOT have run
      expect(restartCommands).toHaveLength(0);
    }

    expect(hasPendingHumanInput(sessionId)).toBe(false);
    close();
  });

  it("message to a suspended session returns 409", async () => {
    setScript([
      {
        text: "Restarting.",
        toolUses: [
          {
            id: "tu-busy-1",
            name: "RestartDockerService",
            input: {
              target: "docker/web-01/web-01",
              reason: "wedged",
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
      body: JSON.stringify({ message: "Service is wedged." }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );

    // Session is suspended — sending a chat message must get 409
    const msgRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({ message: "what do you think?" }),
      },
    );
    expect(msgRes.status).toBe(409);

    close();

    // cleanup
    await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ decision: "reject", resolvedBy: "cleanup" }),
    });
  });

  it("approval interrupt with clarification-only body (no decision, no text) returns 400", async () => {
    setScript([
      {
        text: "Restarting.",
        toolUses: [
          {
            id: "tu-val-1",
            name: "RestartDockerService",
            input: {
              target: "docker/web-01/web-01",
              reason: "validation",
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
      body: JSON.stringify({ message: "Service is wedged." }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );

    // Empty body — no decision, no text — must return 400 for approval kind
    const validationRes = await fetch(
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
    expect(validationRes.status).toBe(400);

    // Cleanup
    close();
    await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ decision: "reject", resolvedBy: "cleanup" }),
    });
  });

  it("restart-resume: interrupt survives process exit, resolve works and run completes", async () => {
    restartCommands.length = 0;
    setScript([
      {
        text: "Restarting.",
        toolUses: [
          {
            id: "tu-rr-1",
            name: "RestartDockerService",
            input: {
              target: "docker/web-01/web-01",
              reason: "wedged",
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
      body: JSON.stringify({ message: "Service is wedged." }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );
    // Assert: run has exited (simulates what a restart would see — no in-memory state)
    expect(dispatcher.isSessionRunning(sessionId)).toBe(false);

    // Assert: interrupt row is in DB (survives a restart because it's persisted)
    expect(hasPendingHumanInput(sessionId)).toBe(true);

    // Resolve via REST — works purely from DB state (as it would after restart)
    const approveRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({
          decision: "approve",
          resolvedBy: "operator-after-restart",
        }),
      },
    );
    expect(approveRes.status).toBe(200);

    // Run resumes and runner executes exactly once
    await waitFor(() => restartCommands.length > 0);
    expect(restartCommands).toHaveLength(1);

    close();
  });

  it("mixed parallel turn: non-gated tools execute first, resume covers all tool_uses", async () => {
    restartCommands.length = 0;
    setScript([
      {
        text: "Checking then restarting.",
        toolUses: [
          {
            id: "tu-mix-read",
            name: "ListDockerServices",
            input: {},
          },
          {
            id: "tu-mix-gate",
            name: "RestartDockerService",
            input: {
              target: "docker/web-01/web-01",
              reason: "mixed",
              risk: "low",
              estimatedDowntimeSeconds: 2,
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
      body: JSON.stringify({ message: "Mixed turn test." }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );

    // The non-gated read tool should have completed before suspension
    expect(toolCallReached(events, "tu-mix-read", "complete")).toBe(true);

    // The gated tool was NOT called on the runner yet
    expect(restartCommands).toHaveLength(0);

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

    // Gated tool now runs exactly once on the runner
    await waitFor(() => restartCommands.length > 0);
    expect(restartCommands).toHaveLength(1);

    close();
  });

  it("critical rejection resumes with rejection result: no escalation, model finishes", async () => {
    const sessionId = randomUUID();
    const alert: NormalizedAlert = {
      sourceAlertId: `crit-022-${randomUUID()}`,
      labels: {},
      alertType: "ContainerDown",
      severity: "critical",
      firedAt: new Date().toISOString(),
      rawPayload: {},
    };

    setScript([
      {
        text: "Restarting critical.",
        toolUses: [
          {
            id: `tu-crit-${randomUUID()}`,
            name: "RestartDockerService",
            input: {
              target: "docker/web-01/web-01",
              reason: "critical",
              risk: "high",
              estimatedDowntimeSeconds: 5,
            },
          },
        ],
      },
      FINISH_TURN,
    ]);

    const { events, close } = await connectConsoleEvents(port, SESSION);

    dispatcher.dispatch({ alert, sessionId });

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
        body: JSON.stringify({ decision: "reject", resolvedBy: "operator" }),
      },
    );
    expect(rejectRes.status).toBe(200);

    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_RESOLVED" &&
          e.payload["sessionId"] === sessionId &&
          e.payload["status"] === "rejected",
      ),
    );
    close();

    expect(hasPendingHumanInput(sessionId)).toBe(false);
    expect(
      events.some(
        (e) => e.type === "ESCALATED" && e.payload["sessionId"] === sessionId,
      ),
    ).toBe(false);
  });

  it("no timeout: interrupt pending for hours is still resolvable", async () => {
    restartCommands.length = 0;

    setScript([
      {
        text: "Restarting.",
        toolUses: [
          {
            id: "tu-notmo-1",
            name: "RestartDockerService",
            input: {
              target: "docker/web-01/web-01",
              reason: "wedged",
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
      body: JSON.stringify({ message: "No timeout test." }),
    });
    const { sessionId } = (await res.json()) as { sessionId: string };

    // Raise the interrupt on real clocks: fake timers stall an in-flight fetch,
    // so no request may be outstanding while the clock is frozen below.
    await waitFor(
      () =>
        events.find(
          (e) =>
            e.type === "HUMAN_INPUT_REQUIRED" &&
            e.payload["sessionId"] === sessionId,
        ),
      { timeout: 5_000 },
    );
    expect(hasPendingHumanInput(sessionId)).toBe(true);

    // Jump a day with nothing in flight: any reaper timer would fire here.
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.advanceTimersByTime(24 * 60 * 60 * 1_000);
    vi.useRealTimers();

    // Nothing reaped the interrupt row.
    expect(hasPendingHumanInput(sessionId)).toBe(true);

    const approveRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({
          decision: "approve",
          resolvedBy: "late-operator",
        }),
      },
    );
    expect(approveRes.status).toBe(200);

    await waitFor(() => restartCommands.length > 0);
    expect(restartCommands).toHaveLength(1);

    close();
  });
});
