import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

vi.mock("../llm/factory.js", () => import("./llm-factory-mock.js"));

import { mockCreateProvider } from "./llm-factory-mock.js";

import {
  createContractFakeProvider,
  createGateController,
} from "./contract-fake-provider.js";

mockCreateProvider.mockImplementation(() =>
  createContractFakeProvider([{ toolUses: [], text: "Done." }]),
);

import { connectTestMetrics, useTempDb } from "./temp-db.js";
import { mintTestSession } from "./session-helper.js";
import { waitFor } from "./wait.js";
import { connectConsoleEvents } from "./console-events-helper.js";

import { registerSessionRoutes } from "../session/routes.js";
import { registerConsoleEventRoutes } from "../session/events.js";
import { dispatcher } from "../dispatcher.js";
import { hasPendingHumanInput } from "../db/interrupts.js";
import { deleteMetricsBackend } from "../db/metrics.js";
import { mountApi } from "./api-server.js";

describe("POST /sessions/:id/stop", () => {
  let server: FastifyInstance;
  let port: number;
  let cleanupDb: () => void;
  let SESSION: string;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();

    server = Fastify({ logger: false });
    await mountApi(server, registerSessionRoutes, registerConsoleEventRoutes);
    await server.listen({ port: 0, host: "127.0.0.1" });
    port = (server.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
    vi.unstubAllEnvs();
  });

  it("returns 401 without a valid nw_auth cookie", async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/sessions/unknown/stop`,
      {
        method: "POST",
      },
    );
    expect(res.status).toBe(401);
  });

  it("returns 409 when the session is not running", async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/sessions/unknown/stop`,
      {
        method: "POST",
        headers: { Cookie: `nw_auth=${SESSION}` },
      },
    );
    expect(res.status).toBe(409);
  });

  it("stops a running session and returns 200", async () => {
    const gateController = createGateController();
    mockCreateProvider.mockImplementationOnce(() =>
      createContractFakeProvider([{ toolUses: [], text: "Done." }], {
        gate: gateController.gate,
      }),
    );

    const chatRes = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Long running." }),
    });
    const { sessionId } = (await chatRes.json()) as { sessionId: string };
    await waitFor(() => dispatcher.isSessionRunning(sessionId));

    const stopRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/stop`,
      {
        method: "POST",
        headers: { Cookie: `nw_auth=${SESSION}` },
      },
    );
    expect(stopRes.status).toBe(200);

    gateController.releaseAll();
    await waitFor(() => !dispatcher.isSessionRunning(sessionId));
  });

  // The stop lands while the turn's read is still running, so the run reaches
  // the write already aborted - the only window this can happen in.
  it("ends a run as stopped when the stop lands on a turn holding a write", async () => {
    const backendId = connectTestMetrics({ queryUrl: "http://prom.test" });
    mockCreateProvider.mockImplementationOnce(() =>
      createContractFakeProvider([
        {
          text: "Checking, then I need you.",
          toolUses: [
            { id: "tu-read", name: "QueryMetrics", input: { query: "up" } },
            {
              id: "tu-ask",
              name: "AskUserQuestion",
              input: {
                question: "Which cluster?",
                options: [{ label: "prod", description: "the live one" }],
              },
            },
          ],
        },
      ]),
    );

    // Parks the read so the stop has somewhere to land: the loop is inside
    // processToolUses, past every abort check it currently makes.
    let releaseRead = (): void => {};
    let readStarted = false;
    const reading = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (!url.startsWith("http://prom.test")) return realFetch(input, init);
        readStarted = true;
        return reading.then(
          () =>
            new Response(
              JSON.stringify({
                status: "success",
                data: { resultType: "vector", result: [] },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
        );
      }),
    );

    const console = await connectConsoleEvents(port, SESSION);
    const chatRes = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Look and then ask." }),
    });
    const { sessionId } = (await chatRes.json()) as { sessionId: string };
    await waitFor(() => readStarted);

    const stopRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/stop`,
      { method: "POST", headers: { Cookie: `nw_auth=${SESSION}` } },
    );
    expect(stopRes.status).toBe(200);

    releaseRead();
    await waitFor(() =>
      console.events.some(
        (e) => e.type === "RUN_STOPPED" && e.payload["sessionId"] === sessionId,
      ),
    );

    expect(dispatcher.isSessionRunning(sessionId)).toBe(false);
    // Nothing to approve: the user stopped the run before the write ran.
    expect(hasPendingHumanInput(sessionId)).toBe(false);
    expect(
      console.events.some(
        (e) =>
          e.type === "HUMAN_INPUT_REQUIRED" &&
          e.payload["sessionId"] === sessionId,
      ),
    ).toBe(false);

    console.close();
    vi.unstubAllGlobals();
    deleteMetricsBackend(backendId);
  });
});
