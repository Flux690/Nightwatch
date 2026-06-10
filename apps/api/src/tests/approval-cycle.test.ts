import "dotenv/config";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import Fastify from "fastify";
import FastifyWebSocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { Worker } from "bullmq";
import type { RunnerCommandMessage } from "@nightwatch/shared";

// A gated runner tool (restart_container) on the first turn, then conclude.
// The loop must pause at the gate and only execute the restart after approval.
const { mockCreateProvider } = vi.hoisted(() => {
  let chatCalls = 0;
  const provider = {
    start: vi.fn(),
    seed: vi.fn(),
    snapshot: vi.fn(() => [
      { role: "user", content: "Service is wedged.", providerContent: {} },
      { role: "assistant", content: "Restarting.", providerContent: {} },
    ]),
    chat: vi.fn(
      (
        _tools: unknown,
        onDelta?: (d: { kind: string; text: string }) => void,
      ) => {
        chatCalls++;
        if (chatCalls === 1) {
          onDelta?.({ kind: "text", text: "Restarting the container." });
          return Promise.resolve({
            stopReason: "tool_use" as const,
            toolUses: [
              {
                id: "restart-1",
                name: "restart_container",
                input: {
                  containerName: "web-01",
                  rationale: "Process table is wedged.",
                  risk: "high",
                  estimatedDowntimeSeconds: 5,
                },
              },
            ],
            text: "Restarting the container.",
          });
        }
        return Promise.resolve({
          stopReason: "tool_use" as const,
          toolUses: [
            {
              id: "conclude-1",
              name: "conclude",
              input: {
                rootCause: {
                  summary: "Wedged process table; restart cleared it.",
                  evidence: ["Container unresponsive"],
                  contributingFactors: null,
                },
                recommendedAction: null,
                escalateIfRejected: false,
                investigationSteps: ["Restarted web-01"],
              },
            },
          ],
          text: "Done.",
        });
      },
    ),
    appendToolResults: vi.fn(),
    appendUserMessage: vi.fn(),
  };

  return { mockCreateProvider: vi.fn(() => provider) };
});

vi.mock("../llm/factory.js", () => ({
  createProvider: mockCreateProvider,
}));

import { db } from "../db/client.js";
import { registerConsoleWsRoutes } from "../ws/console.js";
import { registerChatRoutes } from "../chat/routes.js";
import { registerSessionRoutes } from "../sessions/routes.js";
import { registerIncidentRoutes } from "../incidents/routes.js";
import { startWorker } from "../jobs/worker.js";
import {
  registerRunner,
  unregisterRunner,
  resolveCommand,
} from "../ws/router.js";

interface WsEvent {
  type: string;
  payload: Record<string, unknown>;
}

describe("approval cycle", () => {
  let server: FastifyInstance;
  let worker: Worker;
  let port: number;
  let userId: string;
  const TEST_TOKEN = `test-${randomUUID()}`;
  const TEST_RUNNER_ID = "test-runner-approval";
  const restartCommands: Array<Record<string, unknown>> = [];
  const storedMessages: Record<string, unknown[]> = {};

  beforeAll(async () => {
    const user = await db.user.create({
      data: { email: `test-${randomUUID()}@nightwatch-test.local` },
    });
    userId = user.id;
    await db.token.create({
      data: { token: TEST_TOKEN, userId, hostname: "test-runner" },
    });

    registerRunner(TEST_TOKEN, TEST_RUNNER_ID, (raw: string) => {
      const msg = JSON.parse(raw) as RunnerCommandMessage;
      const { commandName, commandInput, correlationId } = msg.payload;

      if (commandName === "restart_container") {
        restartCommands.push(commandInput);
        resolveCommand({
          correlationId,
          success: true,
          result: { restarted: true, container: commandInput["containerName"] },
        });
      } else if (commandName === "append_session_message") {
        const message = commandInput["message"] as { sessionId: string };
        storedMessages[message.sessionId] ??= [];
        storedMessages[message.sessionId].push(commandInput["message"]);
        resolveCommand({ correlationId, success: true, result: { ok: true } });
      } else if (commandName === "get_session_messages") {
        const sessionId = commandInput["sessionId"] as string;
        resolveCommand({
          correlationId,
          success: true,
          result: storedMessages[sessionId] ?? [],
        });
      } else {
        resolveCommand({ correlationId, success: true, result: [] });
      }
    });

    server = Fastify({ logger: false });
    await server.register(FastifyWebSocket);
    await registerConsoleWsRoutes(server);
    await registerChatRoutes(server);
    await registerSessionRoutes(server);
    await registerIncidentRoutes(server);
    await server.listen({ port: 0, host: "127.0.0.1" });
    port = (server.server.address() as AddressInfo).port;

    worker = startWorker();
    await worker.waitUntilReady();
  });

  afterAll(async () => {
    await worker.close();
    unregisterRunner(TEST_TOKEN, TEST_RUNNER_ID);
    await server.close();
    await db.token.deleteMany({ where: { userId } });
    await db.user.delete({ where: { id: userId } });
    await db.$disconnect();
  });

  it("pauses at a gated tool, resumes on approve, executes the write", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/console/connect`);
    const events: WsEvent[] = [];

    let sessionId: string | undefined;
    let resolveAwaiting: (e: WsEvent) => void = () => {};
    const awaitingArrived = new Promise<WsEvent>((res) => {
      resolveAwaiting = res;
    });
    let resolveResult: () => void = () => {};
    const restartResultArrived = new Promise<void>((res) => {
      resolveResult = res;
    });

    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as WsEvent;
      if (msg.type === "connected") return;
      events.push(msg);
      if (
        msg.type === "tool_call" &&
        msg.payload["sessionId"] === sessionId &&
        msg.payload["phase"] === "start" &&
        msg.payload["awaitingApproval"] === true
      ) {
        resolveAwaiting(msg);
      }
      if (
        msg.type === "tool_call" &&
        msg.payload["sessionId"] === sessionId &&
        msg.payload["toolUseId"] === "restart-1" &&
        msg.payload["phase"] === "result"
      ) {
        resolveResult();
      }
    });

    await new Promise<void>((res) => ws.on("open", res));

    const res = await fetch(`http://127.0.0.1:${port}/chat/${TEST_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Service is wedged." }),
    });
    expect(res.status).toBe(202);
    ({ sessionId } = (await res.json()) as { sessionId: string });

    const awaiting = await Promise.race([
      awaitingArrived,
      new Promise<WsEvent>((_, rej) =>
        setTimeout(
          () => rej(new Error("timeout: no awaitingApproval")),
          10_000,
        ),
      ),
    ]);

    // The console needs the incidentId to address the approve endpoint, and it
    // must travel on the gated start event (the join key the loop is blocked on).
    expect(awaiting.payload["toolName"]).toBe("restart_container");
    const incidentId = awaiting.payload["incidentId"];
    expect(typeof incidentId).toBe("string");

    // The write must not have executed yet - the loop is paused at the gate.
    expect(restartCommands).toHaveLength(0);

    const approveRes = await fetch(
      `http://127.0.0.1:${port}/incidents/${String(incidentId)}/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolvedBy: "operator" }),
      },
    );
    expect(approveRes.status).toBe(200);

    await Promise.race([
      restartResultArrived,
      new Promise<void>((_, rej) =>
        setTimeout(
          () => rej(new Error("timeout: loop did not resume")),
          10_000,
        ),
      ),
    ]);

    ws.close();

    // The gate resolved, the write ran exactly once, and an approval_update was
    // broadcast to the console.
    expect(restartCommands).toHaveLength(1);
    expect(restartCommands[0]["containerName"]).toBe("web-01");

    const approvalUpdates = events.filter(
      (e) =>
        e.type === "approval_update" && e.payload["toolUseId"] === "restart-1",
    );
    expect(approvalUpdates.length).toBeGreaterThan(0);
    expect(approvalUpdates[0].payload["status"]).toBe("approved");
  });
});
