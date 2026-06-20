import "dotenv/config";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

const { mockCreateProvider } = vi.hoisted(() => ({
  mockCreateProvider: vi.fn(),
}));

vi.mock("../llm/factory.js", () => ({ createProvider: mockCreateProvider }));

import {
  createContractFakeProvider,
  createGateController,
} from "./contract-fake-provider.js";

mockCreateProvider.mockImplementation(() =>
  createContractFakeProvider([{ toolUses: [], text: "Done." }]),
);

import { useTempDb } from "./temp-db.js";
import { mintTestSession } from "./session-helper.js";
import { waitFor } from "./wait.js";

import { registerSessionRoutes } from "../session/routes.js";
import { dispatcher } from "../dispatcher.js";

describe("POST /sessions/:id/stop", () => {
  let server: FastifyInstance;
  let port: number;
  let cleanupDb: () => void;
  let SESSION: string;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();

    server = Fastify({ logger: false });
    await registerSessionRoutes(server);
    await server.listen({ port: 0, host: "127.0.0.1" });
    port = (server.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
    vi.unstubAllEnvs();
  });

  it("returns 401 without a valid nw_auth cookie", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/sessions/unknown/stop`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("returns 409 when the session is not running", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/sessions/unknown/stop`, {
      method: "POST",
      headers: { Cookie: `nw_auth=${SESSION}` },
    });
    expect(res.status).toBe(409);
  });

  it("stops a running session and returns 200", async () => {
    const gateController = createGateController();
    mockCreateProvider.mockImplementationOnce(() =>
      createContractFakeProvider([{ toolUses: [], text: "Done." }], {
        gate: gateController.gate,
      }),
    );

    const chatRes = await fetch(`http://127.0.0.1:${port}/chat`, {
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
      `http://127.0.0.1:${port}/sessions/${sessionId}/stop`,
      {
        method: "POST",
        headers: { Cookie: `nw_auth=${SESSION}` },
      },
    );
    expect(stopRes.status).toBe(200);

    gateController.releaseAll();
    await waitFor(() => !dispatcher.isSessionRunning(sessionId));
  });
});
