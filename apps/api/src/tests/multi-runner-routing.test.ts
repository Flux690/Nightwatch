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
  DockerServiceIdentity,
  RunnerManifest,
  RunnerCommandMessage,
} from "@nightwarden/shared";

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

import { generateRunnerToken } from "../db/runner.js";
import { useTempDb } from "./temp-db.js";
import { mintTestSession } from "./session-helper.js";
import { waitFor } from "./wait.js";
import {
  registerRunner,
  unregisterRunner,
  setRunnerManifest,
} from "../ws/fleet.js";
import type { RunnerConnection } from "../ws/fleet.js";
import { resolveCommand } from "../ws/command-transport.js";
import { dispatcher } from "../dispatcher.js";
import { createSession, getTranscriptRows } from "../db/sessions.js";
import { registerConsoleEventRoutes } from "../session/events.js";
import { connectConsoleEvents } from "./console-events-helper.js";

import { registerSessionRoutes } from "../session/routes.js";
import { mountApi } from "./api-server.js";
import {
  dockerService,
  kubernetesManifest,
  kubernetesWorkload,
  manifest,
} from "./manifest-helper.js";

// A free-form text finish: no tool call ends the run successfully.
const FINISH_TURN = {
  text: "Found root cause. Investigation complete.",
  toolUses: [],
};

// Anonymous-container convention (no Compose labels): project === service === name.
function svc(name: string): DockerServiceIdentity {
  return { project: name, service: name };
}

function makeManifest(hostname: string, containers: string[]): RunnerManifest {
  return manifest(hostname, containers.map(dockerService));
}

function makeK8sManifest(
  hostname: string,
  workloads: Array<{ workload: string; namespace: string }>,
): RunnerManifest {
  return kubernetesManifest(
    hostname,
    workloads.map(({ workload, namespace }) =>
      kubernetesWorkload(namespace, workload),
    ),
  );
}

function makeSend(
  log: Array<{ commandName: string; commandInput: Record<string, unknown> }>,
) {
  return (raw: string) => {
    const msg = JSON.parse(raw) as RunnerCommandMessage;
    const { commandName, commandInput, correlationId } = msg.payload;
    log.push({ commandName, commandInput });
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
    vi.stubEnv("SECRET_KEY", "test-only-secret-key-for-routing-tests-32b");
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();
    runnerIdA = generateRunnerToken("docker", "routing-a").id;
    runnerIdB = generateRunnerToken("docker", "routing-b").id;

    conns.push(
      registerRunner({
        runnerId: runnerIdA,
        platform: "docker",
        send: makeSend(commandsA),
        close: () => {},
      }),
    );
    setRunnerManifest(runnerIdA, makeManifest("web-01", ["nginx", "api"]));

    conns.push(
      registerRunner({
        runnerId: runnerIdB,
        platform: "docker",
        send: makeSend(commandsB),
        close: () => {},
      }),
    );
    setRunnerManifest(runnerIdB, makeManifest("db-02", ["postgres"]));

    runnerId2 = generateRunnerToken("docker", "routing-cross").id;
    conns.push(
      registerRunner({
        runnerId: runnerId2,
        platform: "docker",
        send: makeSend(commandsC),
        close: () => {},
      }),
    );
    setRunnerManifest(runnerId2, makeManifest("cache-01", ["redis"]));

    runnerIdK = generateRunnerToken("kubernetes", "routing-k8s").id;
    conns.push(
      registerRunner({
        runnerId: runnerIdK,
        platform: "kubernetes",
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
    await mountApi(server, registerConsoleEventRoutes);
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
    createSession(
      { sessionId, title: "t", createdAt: new Date().toISOString() },
      [],
    );
    dispatcher.dispatch({
      sessionId,
      userMessage: "investigate",
    });
    await waitFor(() => !dispatcher.isSessionRunning(sessionId));
    return sessionId;
  }

  it("container-targeted command routes to the runner that owns the container", async () => {
    setScript([
      {
        text: "Checking postgres.",
        toolUses: [
          {
            id: "tu-1",
            name: "GetDockerLogs",
            input: { target: "docker/postgres/postgres" },
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
            id: "tu-2",
            name: "GetDockerStats",
            input: { target: "docker/nginx/nginx" },
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
            id: "tu-3",
            name: "GetDockerLogs",
            input: { target: "docker/ghost-svc/ghost-svc" },
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
    const messages = getTranscriptRows(sessionId);
    const errorMsg = messages.find(
      (m) => m.kind === "user" && m.content.includes("ghost-svc"),
    );
    expect(errorMsg?.content).toMatch(/nginx/);
    expect(errorMsg?.content).toMatch(/api/);
    expect(errorMsg?.content).toMatch(/postgres/);
  });

  it("a host command naming a runner reaches only that runner", async () => {
    setScript([
      {
        text: "Checking db-02 host memory.",
        toolUses: [
          {
            id: "tu-4",
            name: "GetHostMemory",
            input: { runner: "db-02" },
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
        toolUses: [{ id: "tu-5", name: "GetHostMemory", input: {} }],
      },
      FINISH_TURN,
    ]);

    const sessionId = await runSession();

    // Omitting the runner is a fan-out, not a mistake to correct.
    expect(commandsA).toHaveLength(1);
    expect(commandsB).toHaveLength(1);

    // Each answer is attributed, so the model can tell which host is the sick one.
    const messages = getTranscriptRows(sessionId);
    const result = messages.find(
      (m) => m.kind === "user" && m.content.includes("byRunner"),
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
            id: "tu-restart",
            name: "RestartDockerService",
            input: {
              target: "docker/postgres/postgres",
              reason: "OOM killed",
              risk: "low",
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
          Cookie: `nw_auth=${SESSION}`,
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
            id: "tu-cross",
            name: "GetDockerLogs",
            input: { target: "docker/redis/redis" },
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
            id: "tu-k8s",
            name: "GetK8sLogs",
            input: { target: "kubernetes/production/api-server" },
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
