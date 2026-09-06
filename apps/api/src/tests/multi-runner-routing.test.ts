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
import { initSecrets } from "../secrets.js";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { RunnerManifest, RunnerCommandMessage } from "@nightwarden/shared";

// Stateful scripted provider — same pattern as approval-cycle.test.ts so the
// loop runs against a deterministic turn sequence without a real LLM.
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

import { generateRunnerToken } from "../fleet/runners-store.js";
import { useTempDb } from "./temp-db.js";
import { issueTestSession } from "./session-helper.js";
import { waitFor } from "./wait.js";
import {
  registerRunner,
  unregisterRunner,
  setRunnerManifest,
} from "../fleet/connections.js";
import type { RunnerConnection } from "../fleet/connections.js";
import { resolveCommand } from "../fleet/transport.js";
import { dispatcher } from "../dispatcher.js";
import { createSession } from "../session/store.js";
import { getTranscriptRows } from "../session/transcript-store.js";
import { registerFrontendEventRoutes } from "../session/events.js";
import { connectFrontendEvents } from "./frontend-events-helper.js";

import { registerSessionRoutes } from "../session/routes.js";
import { mountApi } from "./api-server.js";
import {
  dockerService,
  kubernetesManifest,
  kubernetesWorkload,
  manifest,
  svc,
} from "./manifest-helper.js";

// A free-form text finish: no tool call ends the run successfully.
const FINISH_TURN = {
  text: "Found root cause. Investigation complete.",
  toolUses: [],
};

// The server name doubles as the hostname here: this file is about where a
// command lands, and router.test.ts is where the two are told apart.
function makeManifest(server: string, containers: string[]): RunnerManifest {
  return manifest(
    server,
    containers.map((name) => dockerService(server, name)),
  );
}

function makeK8sManifest(
  server: string,
  workloads: Array<{ workload: string; namespace: string }>,
): RunnerManifest {
  return kubernetesManifest(
    server,
    workloads.map(({ workload, namespace }) =>
      kubernetesWorkload(server, namespace, workload),
    ),
  );
}

// Set by a test that wants the runner to answer with its own failure, the way
// a real one does when it cannot resolve the target.
let runnerError: string | null = null;

function makeSend(
  log: Array<{ commandName: string; commandInput: Record<string, unknown> }>,
) {
  return (raw: string) => {
    const msg = JSON.parse(raw) as RunnerCommandMessage;
    if (msg.type !== "command") return;
    const { commandName, commandInput, correlationId } = msg.payload;
    log.push({ commandName, commandInput });
    if (runnerError !== null) {
      resolveCommand({
        correlationId,
        success: false,
        result: null,
        error: runnerError,
      });
      return;
    }
    resolveCommand({ correlationId, success: true, result: {} });
  };
}

describe("multi-runner routing", () => {
  let cleanupDb: () => void;
  let runnerIdA: string;
  let runnerIdB: string;
  let SESSION: string;
  let server: FastifyInstance;
  let port: number;

  // Per-runner command logs — cleared before each test.
  const commandsA: Array<{
    commandName: string;
    commandInput: Record<string, unknown>;
  }> = [];
  const commandsB: Array<{
    commandName: string;
    commandInput: Record<string, unknown>;
  }> = [];
  // runner-c is on a separate runner to test cross-runner routing.
  let runnerId2: string;
  const commandsC: Array<{
    commandName: string;
    commandInput: Record<string, unknown>;
  }> = [];
  // runner-k8s hosts Kubernetes workloads.
  let runnerIdK: string;
  const commandsK: Array<{
    commandName: string;
    commandInput: Record<string, unknown>;
  }> = [];
  const conns: RunnerConnection[] = [];

  beforeAll(async () => {
    vi.stubEnv(
      "NIGHTWARDEN_SECRET_KEY",
      "test-only-secret-key-for-routing-tests-32b",
    );
    initSecrets();
    cleanupDb = await useTempDb();
    SESSION = await issueTestSession();
    runnerIdA = (await generateRunnerToken("docker", "web-01")).id;
    runnerIdB = (await generateRunnerToken("docker", "db-02")).id;

    conns.push(
      registerRunner({
        runnerId: runnerIdA,
        platform: "docker",
        serverName: "web-01",
        send: makeSend(commandsA),
        close: () => {},
      }),
    );
    setRunnerManifest(runnerIdA, makeManifest("web-01", ["nginx", "api"]));

    conns.push(
      registerRunner({
        runnerId: runnerIdB,
        platform: "docker",
        serverName: "db-02",
        send: makeSend(commandsB),
        close: () => {},
      }),
    );
    setRunnerManifest(runnerIdB, makeManifest("db-02", ["postgres"]));

    runnerId2 = (await generateRunnerToken("docker", "cache-01")).id;
    conns.push(
      registerRunner({
        runnerId: runnerId2,
        platform: "docker",
        serverName: "cache-01",
        send: makeSend(commandsC),
        close: () => {},
      }),
    );
    setRunnerManifest(runnerId2, makeManifest("cache-01", ["redis"]));

    runnerIdK = (await generateRunnerToken("kubernetes", "k8s-cluster-01")).id;
    conns.push(
      registerRunner({
        runnerId: runnerIdK,
        platform: "kubernetes",
        serverName: "k8s-cluster-01",
        send: makeSend(commandsK),
        close: () => {},
      }),
    );
    setRunnerManifest(
      runnerIdK,
      makeK8sManifest("k8s-cluster-01", [
        { workload: "api-server", namespace: "production" },
      ]),
    );

    server = Fastify({ logger: false, forceCloseConnections: true });
    await mountApi(server, registerFrontendEventRoutes);
    await mountApi(server, registerSessionRoutes);
    await server.listen({ port: 0, host: "127.0.0.1" });
    port = (server.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    for (const conn of conns.splice(0)) unregisterRunner(conn);
    await server.close();
    cleanupDb();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    commandsA.length = 0;
    commandsB.length = 0;
    commandsC.length = 0;
    commandsK.length = 0;
  });

  async function runSession(): Promise<string> {
    const sessionId = randomUUID();
    // The chat route writes the row before dispatching, so that a run always has
    // a session to claim; this drives the dispatcher directly and must do the same.
    await createSession({
      sessionId,
      title: "t",
      createdAt: new Date().toISOString(),
    });
    await dispatcher.dispatch({
      sessionId,
      userMessage: "investigate",
    });
    await waitFor(async () => !(await dispatcher.isSessionRunning(sessionId)));
    return sessionId;
  }

  it("container-targeted command routes to the runner that owns the container", async () => {
    setScript([
      {
        text: "Checking postgres.",
        toolUses: [
          {
            toolCallId: "tu-1",
            name: "GetDockerLogs",
            input: { target: "db-02/postgres/postgres" },
          },
        ],
      },
      FINISH_TURN,
    ]);

    await runSession();

    expect(commandsB).toHaveLength(1);
    expect(commandsB[0].commandName).toBe("GetDockerLogs");
    expect(commandsA).toHaveLength(0);
  });

  it("routes to the other runner for a container it owns", async () => {
    setScript([
      {
        text: "Checking nginx.",
        toolUses: [
          {
            toolCallId: "tu-2",
            name: "GetDockerStats",
            input: { target: "web-01/nginx/nginx" },
          },
        ],
      },
      FINISH_TURN,
    ]);

    await runSession();

    expect(commandsA).toHaveLength(1);
    expect(commandsA[0].commandName).toBe("GetDockerStats");
    expect(commandsB).toHaveLength(0);
  });

  it("unknown container produces a tool error naming all known containers", async () => {
    setScript([
      {
        text: "Checking unknown service.",
        toolUses: [
          {
            toolCallId: "tu-3",
            name: "GetDockerLogs",
            input: { target: "web-01/ghost-svc/ghost-svc" },
          },
        ],
      },
      FINISH_TURN,
    ]);

    const sessionId = await runSession();

    // Neither runner should have executed the command (routing rejected it).
    expect(commandsA).toHaveLength(0);
    expect(commandsB).toHaveLength(0);

    // The error is persisted as a user-turn message in the transcript.
    const messages = await getTranscriptRows(sessionId);
    const errorMsg = messages.find(
      (m) => m.kind === "user" && m.content.includes("ghost-svc"),
    );
    expect(errorMsg?.content).toMatch(/nginx/);
    expect(errorMsg?.content).toMatch(/api/);
    expect(errorMsg?.content).toMatch(/postgres/);
  });

  // A container that is not running is the finding, not a broken tool. It was
  // classed as system, which tells the agent its evidence proves nothing.
  it("says a service the runner cannot find is an answer, not a fault", async () => {
    setScript([
      {
        text: "Reading logs.",
        toolUses: [
          {
            toolCallId: "tu-missing",
            name: "GetDockerLogs",
            input: { target: "web-01/nginx/nginx" },
          },
        ],
      },
      FINISH_TURN,
    ]);
    runnerError = "No running container found for nginx/nginx";
    const sessionId = await runSession();
    runnerError = null;

    const answer = await (
      await getTranscriptRows(sessionId)
    )
      .flatMap((row) => row.parts)
      .find((p) => p.type === "tool_result" && p.toolCallId === "tu-missing");
    expect(answer).toMatchObject({ isError: true });
    // And it says what that means, rather than naming the tool and stopping.
    expect(answer?.type === "tool_result" && answer.output).toContain(
      "That is an answer, not a fault",
    );
  });

  it("a host command naming a runner reaches only that runner", async () => {
    setScript([
      {
        text: "Checking db-02 host memory.",
        toolUses: [
          {
            toolCallId: "tu-4",
            name: "GetHostMemory",
            input: { server: "db-02" },
          },
        ],
      },
      FINISH_TURN,
    ]);

    await runSession();

    expect(commandsB).toHaveLength(1);
    expect(commandsB[0].commandName).toBe("GetHostMemory");
    expect(commandsA).toHaveLength(0);
  });

  it("a host command with no runner reads every Docker host and names each answer", async () => {
    setScript([
      {
        text: "Checking host memory.",
        toolUses: [{ toolCallId: "tu-5", name: "GetHostMemory", input: {} }],
      },
      FINISH_TURN,
    ]);

    const sessionId = await runSession();

    // Omitting the runner is a fan-out, not a mistake to correct.
    expect(commandsA).toHaveLength(1);
    expect(commandsB).toHaveLength(1);

    // Each answer is attributed, so the model can tell which host is the sick one.
    const messages = await getTranscriptRows(sessionId);
    const result = messages.find(
      (m) => m.kind === "user" && m.content.includes("byServer"),
    );
    expect(result?.content).toMatch(/web-01/);
    expect(result?.content).toMatch(/db-02/);
  });

  it("approved remediation executes on the runner that owns the target container", async () => {
    setScript([
      {
        text: "Restarting postgres.",
        toolUses: [
          {
            toolCallId: "tu-restart",
            name: "RestartDockerService",
            input: {
              target: "db-02/postgres/postgres",
              reason: "OOM killed",
              estimatedDowntimeSeconds: 5,
            },
          },
        ],
      },
      FINISH_TURN,
    ]);

    const { events, close } = await connectFrontendEvents(port, SESSION);

    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${SESSION}`,
      },
      body: JSON.stringify({ message: "postgres is crashing" }),
    });
    expect(res.status).toBe(202);
    const { sessionId } = (await res.json()) as { sessionId: string };

    // Wait for the approval interrupt — RestartDockerService is a gated tool.
    await waitFor(() =>
      events.find(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    );
    // No runner has executed anything yet (sendCommand only runs after approval).
    expect(commandsA).toHaveLength(0);
    expect(commandsB).toHaveLength(0);

    // Approve — the approve route calls sendCommand with the persisted toolInput
    // (which has service: docker/postgres/postgres), routing it to runner-b.
    const approveRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${SESSION}`,
        },
        body: JSON.stringify({ decision: "approve" }),
      },
    );
    expect(approveRes.status).toBe(200);

    // runner-b owns "postgres" and must receive the restart command.
    await waitFor(() =>
      commandsB.some((c) => c.commandName === "RestartDockerService"),
    );
    expect(
      commandsB.find((c) => c.commandName === "RestartDockerService")
        ?.commandInput["service"],
    ).toEqual(svc("postgres"));
    expect(commandsA).toHaveLength(0);

    close();
  });

  it("cross-token: routes to a runner connected under a different token by service identity", async () => {
    // runner-c is registered under a separate runnerId. The flat registry routes globally
    // by service identity, so "redis" (only on runner-c) must still be reached.
    setScript([
      {
        text: "Checking redis.",
        toolUses: [
          {
            toolCallId: "tu-cross",
            name: "GetDockerLogs",
            input: { target: "cache-01/redis/redis" },
          },
        ],
      },
      FINISH_TURN,
    ]);

    await runSession();

    expect(commandsC).toHaveLength(1);
    expect(commandsC[0].commandName).toBe("GetDockerLogs");
    expect(commandsA).toHaveLength(0);
    expect(commandsB).toHaveLength(0);
  });

  it("kubernetes service identity routes to the Kubernetes runner", async () => {
    setScript([
      {
        text: "Checking Kubernetes api-server.",
        toolUses: [
          {
            toolCallId: "tu-k8s",
            name: "GetK8sLogs",
            input: { target: "k8s-cluster-01/production/api-server" },
          },
        ],
      },
      FINISH_TURN,
    ]);

    await runSession();

    expect(commandsK).toHaveLength(1);
    expect(commandsK[0].commandName).toBe("GetK8sLogs");
    expect(commandsA).toHaveLength(0);
    expect(commandsB).toHaveLength(0);
    expect(commandsC).toHaveLength(0);
  });
});
