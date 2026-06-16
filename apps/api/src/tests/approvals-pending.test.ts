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
import { registerApprovalRoutes } from "../approvals/routes.js";
import { registerIncidentRoutes } from "../incidents/routes.js";
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

describe("GET /approvals/pending reads from DB (not in-memory)", () => {
  let server: FastifyInstance;
  let port: number;
  let cleanupDb: () => void;
  let SESSION: string;
  const RUNNER_ID = "runner-pend-022";

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();

    server = Fastify({ logger: false });
    await registerApprovalRoutes(server);
    await registerIncidentRoutes(server);
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

  it("returns pending interrupt rows for the given token", async () => {
    const tokA = generateToken("qa").id;
    registerRunner(
      tokA,
      RUNNER_ID + "-qa",
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

    const chatRes = await fetch(`http://127.0.0.1:${port}/chat/${tokA}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `nw_auth=${SESSION}` },
      body: JSON.stringify({ message: "test" }),
    });
    expect(chatRes.status).toBe(202);

    // Wait for the interrupt row to appear in DB via the endpoint
    const body = await waitFor(async () => {
      const r = await fetch(
        `http://127.0.0.1:${port}/approvals/pending?token=${tokA}`,
      );
      const data = (await r.json()) as ApprovalRequest[];
      return data.length > 0 ? data : null;
    });

    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    const found = body[0];
    expect(found.toolName).toBe("restart_container");
    expect(found.status).toBe("pending");
    expect(found.incidentId).toBeTruthy();

    // Cleanup: reject to free the interrupt row
    await fetch(
      `http://127.0.0.1:${port}/incidents/${found.incidentId}/reject`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: `nw_auth=${SESSION}` },
        body: JSON.stringify({ resolvedBy: "cleanup" }),
      },
    );
    unregisterRunner(tokA, RUNNER_ID + "-qa");
  });

  it("returns 400 when token query param is missing", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/approvals/pending`);
    expect(res.status).toBe(400);
  });

  it("scopes results to queried token — different token sees no rows", async () => {
    const tokC = generateToken("scope-c").id;
    const tokD = generateToken("scope-d").id;

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
      RUNNER_ID + "-c",
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

    const chatRes = await fetch(`http://127.0.0.1:${port}/chat/${tokC}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `nw_auth=${SESSION}` },
      body: JSON.stringify({ message: "scope test" }),
    });
    expect(chatRes.status).toBe(202);

    // Wait for interrupt for tokC
    await waitFor(async () => {
      const r = await fetch(
        `http://127.0.0.1:${port}/approvals/pending?token=${tokC}`,
      );
      const data = (await r.json()) as ApprovalRequest[];
      return data.length > 0 ? true : null;
    });

    // tokD (different token) must see empty
    const resD = await fetch(
      `http://127.0.0.1:${port}/approvals/pending?token=${tokD}`,
    );
    const bodyD = (await resD.json()) as ApprovalRequest[];
    expect(bodyD).toHaveLength(0);

    // Cleanup
    const resC = await fetch(
      `http://127.0.0.1:${port}/approvals/pending?token=${tokC}`,
    );
    const bodyC = (await resC.json()) as ApprovalRequest[];
    if (bodyC[0]) {
      await fetch(
        `http://127.0.0.1:${port}/incidents/${bodyC[0].incidentId}/reject`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: `nw_auth=${SESSION}` },
          body: JSON.stringify({ resolvedBy: "cleanup" }),
        },
      );
    }
    unregisterRunner(tokC, RUNNER_ID + "-c");
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
      RUNNER_ID + "-e",
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

    const chatRes = await fetch(`http://127.0.0.1:${port}/chat/${tokE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `nw_auth=${SESSION}` },
      body: JSON.stringify({ message: "empty after resolve" }),
    });
    expect(chatRes.status).toBe(202);

    // Wait for interrupt
    const body = await waitFor(async () => {
      const r = await fetch(
        `http://127.0.0.1:${port}/approvals/pending?token=${tokE}`,
      );
      const data = (await r.json()) as ApprovalRequest[];
      return data.length > 0 ? data : null;
    });

    const incidentId = body[0]!.incidentId;
    await fetch(`http://127.0.0.1:${port}/incidents/${incidentId}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: `nw_auth=${SESSION}` },
      body: JSON.stringify({ resolvedBy: "op" }),
    });

    // After resolution the list is empty
    await waitFor(async () => {
      const r = await fetch(
        `http://127.0.0.1:${port}/approvals/pending?token=${tokE}`,
      );
      const data = (await r.json()) as ApprovalRequest[];
      return data.length === 0 ? true : null;
    });

    const resAfter = await fetch(
      `http://127.0.0.1:${port}/approvals/pending?token=${tokE}`,
    );
    const bodyAfter = (await resAfter.json()) as ApprovalRequest[];
    expect(bodyAfter).toHaveLength(0);

    unregisterRunner(tokE, RUNNER_ID + "-e");
  });
});

