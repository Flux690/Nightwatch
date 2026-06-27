import "dotenv/config";
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
import WebSocket from "ws";
import Fastify from "fastify";
import FastifyWebSocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type {
  CapabilityManifest,
  RunnerCommandMessage,
} from "@nightwatch/shared";

// Stateful scripted provider — same pattern as approval-cycle.test.ts so the
// loop runs against a deterministic turn sequence without a real LLM.
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
import {
  registerRunner,
  unregisterRunner,
  setRunnerManifest,
} from "../ws/router.js";
import { resolveCommand } from "../ws/command-transport.js";
import { dispatcher } from "../dispatcher.js";
import { getSessionMessages } from "../db/sessions.js";
import { registerConsoleWsRoutes } from "../ws/console.js";

import { registerSessionRoutes } from "../session/routes.js";

// A free-form text finish: no tool call ends the run successfully.
const FINISH_TURN = {
  text: "Found root cause. Investigation complete.",
  toolUses: [],
};

// Anonymous-container convention (no Compose labels): project === service === name.
function svc(name: string): {
  provider: "docker";
  project: string;
  service: string;
} {
  return { provider: "docker", project: name, service: name };
}

function k8sSvc(
  workload: string,
  namespace = "default",
): { provider: "kubernetes"; namespace: string; workload: string } {
  return { provider: "kubernetes", namespace, workload };
}

function scopedSvc(
  name: string,
  server: string,
): { provider: "docker"; project: string; service: string; server: string } {
  return { provider: "docker", project: name, service: name, server };
}

function makeManifest(
  hostname: string,
  containers: string[],
): CapabilityManifest {
  return {
    runnerId: `runner-${hostname}`,
    hostname,
    runnerVersion: "2.0.0",
    capabilities: {
      docker: true,
      kubernetes: false,
      services: containers.map((name) => ({
        identity: svc(name),
        status: "running",
      })),
      prometheus: { available: false },
      postgres: { available: false },
      redis: { available: false },
      hostMetrics: true,
      fileRead: true,
      remediationEnabled: true,
    },
  };
}

function makeK8sManifest(
  hostname: string,
  workloads: Array<{ workload: string; namespace: string }>,
): CapabilityManifest {
  return {
    runnerId: `runner-${hostname}`,
    hostname,
    runnerVersion: "2.0.0",
    capabilities: {
      docker: false,
      kubernetes: true,
      services: workloads.map(({ workload, namespace }) => ({
        identity: k8sSvc(workload, namespace),
        status: "running",
      })),
      prometheus: { available: false },
      postgres: { available: false },
      redis: { available: false },
      hostMetrics: true,
      fileRead: true,
      remediationEnabled: false,
    },
  };
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

describe("multi-runner routing", () => {
  let cleanupDb: () => void;
  let tokenIdA: string;
  let tokenIdB: string;
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
  // runner-c is on a different token to test cross-token routing.
  let tokenId2: string;
  const commandsC: Array<{
    commandName: string;
    commandInput: Record<string, unknown>;
  }> = [];
  // runner-k8s hosts Kubernetes workloads.
  let tokenIdK: string;
  const commandsK: Array<{
    commandName: string;
    commandInput: Record<string, unknown>;
  }> = [];

  beforeAll(async () => {
    vi.stubEnv("SECRET_KEY", "test-only-secret-key-for-routing-tests-32b");
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();
    tokenIdA = generateRunnerToken("routing-a").id;
    tokenIdB = generateRunnerToken("routing-b").id;

    registerRunner(tokenIdA, makeSend(commandsA), () => {});
    setRunnerManifest(tokenIdA, makeManifest("web-01", ["nginx", "api"]));

    registerRunner(tokenIdB, makeSend(commandsB), () => {});
    setRunnerManifest(tokenIdB, makeManifest("db-02", ["postgres"]));

    tokenId2 = generateRunnerToken("routing-cross").id;
    registerRunner(tokenId2, makeSend(commandsC), () => {});
    setRunnerManifest(tokenId2, makeManifest("cache-01", ["redis"]));

    tokenIdK = generateRunnerToken("routing-k8s").id;
    registerRunner(tokenIdK, makeSend(commandsK), () => {});
    setRunnerManifest(
      tokenIdK,
      makeK8sManifest("k8s-cluster-01", [
        { workload: "api-server", namespace: "production" },
      ]),
    );

    server = Fastify({ logger: false });
    await server.register(FastifyWebSocket);
    await registerConsoleWsRoutes(server);
    await registerSessionRoutes(server);
    await server.listen({ port: 0, host: "127.0.0.1" });
    port = (server.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    unregisterRunner(tokenIdA);
    unregisterRunner(tokenIdB);
    unregisterRunner(tokenId2);
    unregisterRunner(tokenIdK);
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
            name: "get_service_logs",
            input: { service: svc("postgres") },
          },
        ],
      },
      FINISH_TURN,
    ]);

    await runSession();

    expect(commandsB).toHaveLength(1);
    expect(commandsB[0].commandName).toBe("get_service_logs");
    expect(commandsA).toHaveLength(0);
  });

  it("routes to the other runner for a container it owns", async () => {
    setScript([
      {
        text: "Checking nginx.",
        toolUses: [
          {
            id: "tu-2",
            name: "get_service_stats",
            input: { service: svc("nginx") },
          },
        ],
      },
      FINISH_TURN,
    ]);

    await runSession();

    expect(commandsA).toHaveLength(1);
    expect(commandsA[0].commandName).toBe("get_service_stats");
    expect(commandsB).toHaveLength(0);
  });

  it("unknown container produces a tool error naming all known containers", async () => {
    setScript([
      {
        text: "Checking unknown service.",
        toolUses: [
          {
            id: "tu-3",
            name: "get_service_logs",
            input: { service: svc("ghost-svc") },
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
    const messages = getSessionMessages(sessionId);
    const errorMsg = messages.find(
      (m) => m.role === "user" && m.content.includes("ghost-svc"),
    );
    expect(errorMsg?.content).toMatch(/nginx/);
    expect(errorMsg?.content).toMatch(/api/);
    expect(errorMsg?.content).toMatch(/postgres/);
  });

  it("host command with hostname routes to the runner with that hostname", async () => {
    setScript([
      {
        text: "Checking db-02 host memory.",
        toolUses: [
          {
            id: "tu-4",
            name: "get_host_memory",
            input: { hostname: "db-02" },
          },
        ],
      },
      FINISH_TURN,
    ]);

    await runSession();

    expect(commandsB).toHaveLength(1);
    expect(commandsB[0].commandName).toBe("get_host_memory");
    expect(commandsA).toHaveLength(0);
  });

  it("host command without hostname on multiple runners produces a tool error listing available hostnames", async () => {
    setScript([
      {
        text: "Checking host memory.",
        toolUses: [{ id: "tu-5", name: "get_host_memory", input: {} }],
      },
      FINISH_TURN,
    ]);

    const sessionId = await runSession();

    // Neither runner should have received the command.
    expect(commandsA).toHaveLength(0);
    expect(commandsB).toHaveLength(0);

    // The error names both registered hostnames so the model can retry.
    const messages = getSessionMessages(sessionId);
    const errorMsg = messages.find(
      (m) => m.role === "user" && m.content.includes("hostname"),
    );
    expect(errorMsg?.content).toMatch(/web-01/);
    expect(errorMsg?.content).toMatch(/db-02/);
  });

  it("approved remediation executes on the runner that owns the target container", async () => {
    setScript([
      {
        text: "Restarting postgres.",
        toolUses: [
          {
            id: "tu-restart",
            name: "restart_service",
            input: {
              service: svc("postgres"),
              rationale: "OOM killed",
              risk: "low",
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
    const events: Array<{ type: string; payload: Record<string, unknown> }> =
      [];
    ws.on("message", (raw) => {
      events.push(
        JSON.parse(raw.toString()) as {
          type: string;
          payload: Record<string, unknown>;
        },
      );
    });
    await waitForConnected(ws);

    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "postgres is crashing" }),
    });
    expect(res.status).toBe(202);
    const { sessionId } = (await res.json()) as { sessionId: string };

    // Wait for the approval interrupt — restart_service is a gated tool.
    const interrupt = await waitFor(() =>
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

    // runner-b owns "postgres" and must receive the restart command.
    await waitFor(() =>
      commandsB.some((c) => c.commandName === "restart_service"),
    );
    expect(
      commandsB.find((c) => c.commandName === "restart_service")
        ?.commandInput["service"],
    ).toEqual(svc("postgres"));
    expect(commandsA).toHaveLength(0);

    ws.close();
  });

  it("cross-token: routes to a runner connected under a different token by service identity", async () => {
    // runner-c is registered under tokenId2, not tokenId. The session dispatches
    // with tokenId. With the flat registry, sendCommand routes globally by
    // service identity, so "redis" (only on runner-c) must still be reached.
    setScript([
      {
        text: "Checking redis.",
        toolUses: [
          {
            id: "tu-cross",
            name: "get_service_logs",
            input: { service: svc("redis") },
          },
        ],
      },
      FINISH_TURN,
    ]);

    await runSession();

    expect(commandsC).toHaveLength(1);
    expect(commandsC[0].commandName).toBe("get_service_logs");
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
            name: "get_service_logs",
            input: { service: k8sSvc("api-server", "production") },
          },
        ],
      },
      FINISH_TURN,
    ]);

    await runSession();

    expect(commandsK).toHaveLength(1);
    expect(commandsK[0].commandName).toBe("get_service_logs");
    expect(commandsA).toHaveLength(0);
    expect(commandsB).toHaveLength(0);
    expect(commandsC).toHaveLength(0);
  });
});

describe("assigned-name server-scoped routing", () => {
  // Two runners whose manifests carry server-scoped Docker identities — the
  // shape produced by the runner when NIGHTWATCH_SERVER_NAME is set. Routing
  // must match exclusively on the full (server, project, service) key.
  let cleanupDb2: () => void;
  let tokenIdS1: string;
  let tokenIdS2: string;

  const commandsS1: Array<{
    commandName: string;
    commandInput: Record<string, unknown>;
  }> = [];
  const commandsS2: Array<{
    commandName: string;
    commandInput: Record<string, unknown>;
  }> = [];

  function makeScopedManifest(
    server: string,
    services: string[],
  ): CapabilityManifest {
    return {
      runnerId: `runner-${server}`,
      hostname: server,
      runnerVersion: "2.0.0",
      capabilities: {
        docker: true,
        kubernetes: false,
        services: services.map((name) => ({
          identity: scopedSvc(name, server),
          status: "running",
        })),
        prometheus: { available: false },
        postgres: { available: false },
        redis: { available: false },
        hostMetrics: true,
        fileRead: true,
        remediationEnabled: false,
      },
    };
  }

  beforeAll(async () => {
    vi.stubEnv("SECRET_KEY", "test-only-secret-key-for-scoped-tests-32byte");
    cleanupDb2 = useTempDb();
    await mintTestSession();

    tokenIdS1 = generateRunnerToken("scoped-runner-1").id;
    registerRunner(tokenIdS1, makeSend(commandsS1), () => {});
    setRunnerManifest(
      tokenIdS1,
      makeScopedManifest("prod-server-01", ["api", "worker"]),
    );

    tokenIdS2 = generateRunnerToken("scoped-runner-2").id;
    registerRunner(tokenIdS2, makeSend(commandsS2), () => {});
    setRunnerManifest(
      tokenIdS2,
      makeScopedManifest("prod-server-02", ["api", "db"]),
    );
  });

  afterAll(() => {
    unregisterRunner(tokenIdS1);
    unregisterRunner(tokenIdS2);
    cleanupDb2();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    commandsS1.length = 0;
    commandsS2.length = 0;
  });

  async function runScopedSession(): Promise<string> {
    const sessionId = randomUUID();
    dispatcher.dispatch({ sessionId, userMessage: "investigate" });
    await waitFor(() => !dispatcher.isSessionRunning(sessionId));
    return sessionId;
  }

  it("routes to the runner whose assigned server name matches the target identity", async () => {
    setScript([
      {
        text: "Checking api on prod-server-01.",
        toolUses: [
          {
            id: "tu-scoped-1",
            name: "get_service_logs",
            input: { service: scopedSvc("api", "prod-server-01") },
          },
        ],
      },
      FINISH_TURN,
    ]);

    await runScopedSession();

    expect(commandsS1).toHaveLength(1);
    expect(commandsS1[0].commandName).toBe("get_service_logs");
    expect(commandsS2).toHaveLength(0);
  });

  it("routes to the other runner when the server name differs", async () => {
    setScript([
      {
        text: "Checking db on prod-server-02.",
        toolUses: [
          {
            id: "tu-scoped-2",
            name: "get_service_logs",
            input: { service: scopedSvc("db", "prod-server-02") },
          },
        ],
      },
      FINISH_TURN,
    ]);

    await runScopedSession();

    expect(commandsS2).toHaveLength(1);
    expect(commandsS2[0].commandName).toBe("get_service_logs");
    expect(commandsS1).toHaveLength(0);
  });

  it("same service name on different servers routes independently — server scope prevents ambiguity", async () => {
    // Both runners advertise "api" — server scope is what disambiguates them.
    // Targeting prod-server-02/api must not reach prod-server-01.
    setScript([
      {
        text: "Checking api on prod-server-02.",
        toolUses: [
          {
            id: "tu-scoped-3",
            name: "get_service_logs",
            input: { service: scopedSvc("api", "prod-server-02") },
          },
        ],
      },
      FINISH_TURN,
    ]);

    await runScopedSession();

    expect(commandsS2).toHaveLength(1);
    expect(commandsS2[0].commandName).toBe("get_service_logs");
    expect(commandsS1).toHaveLength(0);
  });
});
