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
const { mockCreateProvider, setScript } = vi.hoisted(() => {
  type Msg = {
    role: "user" | "assistant";
    content: string;
    providerContent: unknown;
  };
  type Turn = {
    toolUses: Array<{
      id: string;
      name: string;
      input: Record<string, unknown>;
    }>;
    text: string;
  };

  let script: Turn[] = [];
  let scriptIndex = 0;

  const makeProvider = () => {
    const messages: Msg[] = [];
    return {
      start: vi.fn((msg: string) => {
        messages.push({
          role: "user",
          content: msg,
          providerContent: { role: "user", content: msg },
        });
      }),
      seed: vi.fn((history: Msg[]) => {
        messages.length = 0;
        messages.push(...history);
      }),
      snapshot: vi.fn((): Msg[] => [...messages]),
      chat: vi.fn(
        (
          _tools: unknown,
          onDelta?: (d: { kind: string; text: string }) => void,
        ) => {
          const turn = script[scriptIndex++] ??
            script[script.length - 1] ?? { toolUses: [], text: "" };
          onDelta?.({ kind: "text", text: turn.text });
          messages.push({
            role: "assistant",
            content: turn.text,
            providerContent: { role: "assistant", content: turn.text },
          });
          return Promise.resolve({
            stopReason: "tool_use" as const,
            toolUses: turn.toolUses,
            text: turn.text,
          });
        },
      ),
      appendToolResults: vi.fn(
        (results: Array<{ tool_use_id: string; content: string }>) => {
          messages.push({
            role: "user",
            content: results.map((r) => r.content).join("\n"),
            providerContent: { role: "user", content: results },
          });
        },
      ),
      appendUserMessage: vi.fn((msg: string) => {
        messages.push({
          role: "user",
          content: msg,
          providerContent: { role: "user", content: msg },
        });
      }),
    };
  };

  return {
    mockCreateProvider: vi.fn(makeProvider),
    setScript: (turns: Turn[]) => {
      script = turns;
      scriptIndex = 0;
      mockCreateProvider.mockImplementation(makeProvider);
    },
  };
});

vi.mock("../llm/factory.js", () => ({ createProvider: mockCreateProvider }));

import { generateToken } from "../db/tokens.js";
import { useTempDb } from "./temp-db.js";
import { mintTestSession } from "./session-helper.js";
import { waitFor } from "./wait.js";
import {
  registerRunner,
  unregisterRunner,
  setRunnerManifest,
  resolveCommand,
} from "../ws/router.js";
import { dispatcher } from "../dispatch/dispatcher.js";
import { getSessionMessages } from "../db/sessions.js";
import { registerConsoleWsRoutes } from "../ws/console.js";
import { registerChatRoutes } from "../chat/routes.js";
import { registerSessionRoutes } from "../sessions/routes.js";

// A free-form text finish: no tool call ends the run successfully.
const FINISH_TURN = {
  text: "Found root cause. Investigation complete.",
  toolUses: [],
};

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
      containers,
      prometheus: { available: false },
      postgres: { available: false },
      redis: { available: false },
      hostMetrics: true,
      fileRead: true,
      remediationEnabled: true,
    },
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

  function makeSend(
    log: Array<{ commandName: string; commandInput: Record<string, unknown> }>,
  ) {
    return (raw: string) => {
      const msg = JSON.parse(raw) as RunnerCommandMessage;
      const { commandName, commandInput, correlationId } = msg.payload;
      log.push({ commandName, commandInput });
      resolveCommand({
        correlationId,
        success: true,
        result: { restarted: true },
      });
    };
  }

  beforeAll(async () => {
    vi.stubEnv("SECRET_KEY", "test-only-secret-key-for-routing-tests-32b");
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();
    tokenIdA = generateToken("routing-a").id;
    tokenIdB = generateToken("routing-b").id;

    registerRunner(tokenIdA, makeSend(commandsA), () => {});
    setRunnerManifest(tokenIdA, makeManifest("web-01", ["nginx", "api"]));

    registerRunner(tokenIdB, makeSend(commandsB), () => {});
    setRunnerManifest(tokenIdB, makeManifest("db-02", ["postgres"]));

    tokenId2 = generateToken("routing-cross").id;
    registerRunner(tokenId2, makeSend(commandsC), () => {});
    setRunnerManifest(tokenId2, makeManifest("cache-01", ["redis"]));

    server = Fastify({ logger: false });
    await server.register(FastifyWebSocket);
    await registerConsoleWsRoutes(server);
    await registerChatRoutes(server);
    await registerSessionRoutes(server);
    await server.listen({ port: 0, host: "127.0.0.1" });
    port = (server.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    unregisterRunner(tokenIdA);
    unregisterRunner(tokenIdB);
    unregisterRunner(tokenId2);
    await server.close();
    cleanupDb();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    commandsA.length = 0;
    commandsB.length = 0;
    commandsC.length = 0;
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
            name: "get_container_logs",
            input: { containerName: "postgres" },
          },
        ],
      },
      FINISH_TURN,
    ]);

    await runSession();

    expect(commandsB).toHaveLength(1);
    expect(commandsB[0].commandName).toBe("get_container_logs");
    expect(commandsA).toHaveLength(0);
  });

  it("routes to the other runner for a container it owns", async () => {
    setScript([
      {
        text: "Checking nginx.",
        toolUses: [
          {
            id: "tu-2",
            name: "get_container_stats",
            input: { containerName: "nginx" },
          },
        ],
      },
      FINISH_TURN,
    ]);

    await runSession();

    expect(commandsA).toHaveLength(1);
    expect(commandsA[0].commandName).toBe("get_container_stats");
    expect(commandsB).toHaveLength(0);
  });

  it("unknown container produces a tool error naming all known containers", async () => {
    setScript([
      {
        text: "Checking unknown service.",
        toolUses: [
          {
            id: "tu-3",
            name: "get_container_logs",
            input: { containerName: "ghost-svc" },
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
            name: "restart_container",
            input: {
              containerName: "postgres",
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

    // Wait for the approval interrupt — restart_container is a gated tool.
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
    // (which has containerName: "postgres"), routing it to runner-b.
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
      commandsB.some((c) => c.commandName === "restart_container"),
    );
    expect(
      commandsB.find((c) => c.commandName === "restart_container")
        ?.commandInput["containerName"],
    ).toBe("postgres");
    expect(commandsA).toHaveLength(0);

    ws.close();
  });

  it("cross-token: routes to a runner connected under a different token by container name", async () => {
    // runner-c is registered under tokenId2, not tokenId. The session dispatches
    // with tokenId. With the flat registry, sendCommand routes globally by
    // container name, so "redis" (only on runner-c) must still be reached.
    setScript([
      {
        text: "Checking redis.",
        toolUses: [
          {
            id: "tu-cross",
            name: "get_container_logs",
            input: { containerName: "redis" },
          },
        ],
      },
      FINISH_TURN,
    ]);

    await runSession();

    expect(commandsC).toHaveLength(1);
    expect(commandsC[0].commandName).toBe("get_container_logs");
    expect(commandsA).toHaveLength(0);
    expect(commandsB).toHaveLength(0);
  });
});
