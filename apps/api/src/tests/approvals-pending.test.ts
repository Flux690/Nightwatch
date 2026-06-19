import "dotenv/config";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { RunnerCommandMessage } from "@nightwatch/shared";

// Scripted provider: drives the loop to a gated tool so the interrupt row is
// written to the DB, which is what these tests assert against.
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
      chat: vi.fn((_tools: unknown) => {
        const turn = script[scriptIndex++] ??
          script[script.length - 1] ?? { toolUses: [], text: "" };
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
      }),
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
import { registerChatRoutes } from "../chat/routes.js";
import { registerSessionRoutes } from "../sessions/routes.js";
import {
  registerRunner,
  unregisterRunner,
  resolveCommand,
} from "../ws/router.js";
import type { ApprovalRequest } from "@nightwatch/shared";

// A free-form text finish: no tool call ends the run successfully.
const FINISH_TURN = {
  text: "Investigation complete.",
  toolUses: [],
};

describe("GET /sessions/pending-human-input reads from DB (not in-memory)", () => {
  let server: FastifyInstance;
  let port: number;
  let cleanupDb: () => void;
  let SESSION: string;
  const RUNNER_ID = "runner-pend-022";

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();

    server = Fastify({ logger: false });
    await registerChatRoutes(server);
    await registerSessionRoutes(server);
    await server.listen({ port: 0, host: "127.0.0.1" });
    port = (server.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
    vi.unstubAllEnvs();
  });

  it("returns pending interrupt rows with session cookie", async () => {
    const tokA = generateToken("qa").id;
    registerRunner(
      tokA,
      (raw: string) => {
        const msg = JSON.parse(raw) as RunnerCommandMessage;
        resolveCommand({
          correlationId: msg.payload.correlationId,
          success: true,
          result: [],
        });
      },
      () => {},
    );

    setScript([
      {
        text: "Restarting.",
        toolUses: [
          {
            id: `tu-qa-${randomUUID()}`,
            name: "restart_container",
            input: {
              containerName: "web-01",
              rationale: "r",
              risk: "low",
              estimatedDowntimeSeconds: 1,
            },
          },
        ],
      },
      FINISH_TURN,
    ]);

    const chatRes = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "test" }),
    });
    expect(chatRes.status).toBe(202);

    // Wait for the interrupt row to appear in DB via the endpoint
    const body = await waitFor(async () => {
      const r = await fetch(
        `http://127.0.0.1:${port}/sessions/pending-human-input`,
        {
          headers: { Cookie: `nw_auth=${SESSION}` },
        },
      );
      const data = (await r.json()) as ApprovalRequest[];
      return data.length > 0 ? data : null;
    });

    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    const found = body[0];
    expect(found.toolName).toBe("restart_container");
    expect(found.status).toBe("pending");
    expect(found.sessionId).toBeTruthy();

    // Cleanup: reject to free the interrupt row
    await fetch(
      `http://127.0.0.1:${port}/sessions/${found.sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({ decision: "reject", resolvedBy: "cleanup" }),
      },
    );
    unregisterRunner(tokA);
  });

  it("returns 401 without a valid nw_auth cookie", async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/sessions/pending-human-input`,
    );
    expect(res.status).toBe(401);
  });

  it("returns interrupts from all runner tokens (operator-wide)", async () => {
    const tokC = generateToken("scope-c").id;

    setScript([
      {
        text: "Restarting.",
        toolUses: [
          {
            id: `tu-sc-${randomUUID()}`,
            name: "restart_container",
            input: {
              containerName: "web-01",
              rationale: "r",
              risk: "low",
              estimatedDowntimeSeconds: 1,
            },
          },
        ],
      },
      FINISH_TURN,
    ]);

    registerRunner(
      tokC,
      (raw: string) => {
        const msg = JSON.parse(raw) as RunnerCommandMessage;
        resolveCommand({
          correlationId: msg.payload.correlationId,
          success: true,
          result: [],
        });
      },
      () => {},
    );

    const chatRes = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "scope test" }),
    });
    expect(chatRes.status).toBe(202);

    // Operator-wide: endpoint returns the interrupt without needing a token param
    const body = await waitFor(async () => {
      const r = await fetch(
        `http://127.0.0.1:${port}/sessions/pending-human-input`,
        {
          headers: { Cookie: `nw_auth=${SESSION}` },
        },
      );
      const data = (await r.json()) as ApprovalRequest[];
      return data.length > 0 ? data : null;
    });

    expect(body.length).toBeGreaterThan(0);

    // Cleanup
    const found = body[0];
    await fetch(
      `http://127.0.0.1:${port}/sessions/${found.sessionId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({ decision: "reject", resolvedBy: "cleanup" }),
      },
    );
    unregisterRunner(tokC);
  });

  it("returns empty list after interrupt is resolved", async () => {
    const tokE = generateToken("empty-after").id;

    setScript([
      {
        text: "Restarting.",
        toolUses: [
          {
            id: `tu-emp-${randomUUID()}`,
            name: "restart_container",
            input: {
              containerName: "web-01",
              rationale: "r",
              risk: "low",
              estimatedDowntimeSeconds: 1,
            },
          },
        ],
      },
      FINISH_TURN,
    ]);

    registerRunner(
      tokE,
      (raw: string) => {
        const msg = JSON.parse(raw) as RunnerCommandMessage;
        resolveCommand({
          correlationId: msg.payload.correlationId,
          success: true,
          result: [],
        });
      },
      () => {},
    );

    const chatRes = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "empty after resolve" }),
    });
    expect(chatRes.status).toBe(202);

    // Wait for interrupt
    const body = await waitFor(async () => {
      const r = await fetch(
        `http://127.0.0.1:${port}/sessions/pending-human-input`,
        {
          headers: { Cookie: `nw_auth=${SESSION}` },
        },
      );
      const data = (await r.json()) as ApprovalRequest[];
      return data.length > 0 ? data : null;
    });

    const sessionId = body[0].sessionId;
    await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/respond`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ decision: "reject", resolvedBy: "op" }),
    });

    // After resolution the list is empty
    await waitFor(async () => {
      const r = await fetch(
        `http://127.0.0.1:${port}/sessions/pending-human-input`,
        {
          headers: { Cookie: `nw_auth=${SESSION}` },
        },
      );
      const data = (await r.json()) as ApprovalRequest[];
      return data.length === 0 ? true : null;
    });

    const resAfter = await fetch(
      `http://127.0.0.1:${port}/sessions/pending-human-input`,
      {
        headers: { Cookie: `nw_auth=${SESSION}` },
      },
    );
    const bodyAfter = (await resAfter.json()) as ApprovalRequest[];
    expect(bodyAfter.length).toBe(0);

    unregisterRunner(tokE);
  });
});
