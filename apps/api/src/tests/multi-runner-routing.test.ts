import "dotenv/config";
import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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

import { mintToken } from "../db/tokens.js";
import { useTempDb } from "./temp-db.js";
import { waitFor } from "./wait.js";
import {
  registerRunner,
  unregisterRunner,
  setRunnerManifest,
  resolveCommand,
} from "../ws/router.js";
import { dispatcher } from "../dispatch/dispatcher.js";
import { getSessionMessages } from "../db/sessions.js";

const FINAL_RESPONSE_TURN = {
  text: "Done.",
  toolUses: [
    {
      id: "fr-1",
      name: "final_response",
      input: {
        rootCause: {
          summary: "Found root cause.",
          evidence: ["log line"],
          contributingFactors: null,
        },
        recommendedAction: null,
        escalateIfRejected: false,
        investigationSteps: ["checked logs"],
      },
    },
  ],
};

function makeManifest(
  runnerId: string,
  token: string,
  hostname: string,
  containers: string[],
): CapabilityManifest {
  return {
    runnerId,
    token,
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

describe("multi-runner routing", () => {
  let cleanupDb: () => void;
  let tokenId: string;

  // Per-runner command logs — cleared before each test.
  const commandsA: Array<{
    commandName: string;
    commandInput: Record<string, unknown>;
  }> = [];
  const commandsB: Array<{
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
        result: { output: "ok" },
      });
    };
  }

  beforeAll(() => {
    cleanupDb = useTempDb();
    tokenId = mintToken("routing-026").id;

    registerRunner(tokenId, "runner-a", makeSend(commandsA), () => {});
    setRunnerManifest(
      tokenId,
      "runner-a",
      makeManifest("runner-a", tokenId, "web-01", ["nginx", "api"]),
    );

    registerRunner(tokenId, "runner-b", makeSend(commandsB), () => {});
    setRunnerManifest(
      tokenId,
      "runner-b",
      makeManifest("runner-b", tokenId, "db-02", ["postgres"]),
    );
  });

  afterAll(() => {
    unregisterRunner(tokenId, "runner-a");
    unregisterRunner(tokenId, "runner-b");
    cleanupDb();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    commandsA.length = 0;
    commandsB.length = 0;
  });

  async function runSession(): Promise<string> {
    const sessionId = randomUUID();
    dispatcher.dispatch({
      sessionId,
      token: tokenId,
      trigger: "chat",
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
      FINAL_RESPONSE_TURN,
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
      FINAL_RESPONSE_TURN,
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
      FINAL_RESPONSE_TURN,
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
      FINAL_RESPONSE_TURN,
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
      FINAL_RESPONSE_TURN,
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
});
