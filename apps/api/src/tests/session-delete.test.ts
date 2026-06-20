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
import { getSession } from "../db/sessions.js";

describe("DELETE /sessions/:id", () => {
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
    const res = await fetch(`http://127.0.0.1:${port}/sessions/unknown`, {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });

  it("deletes a finished session and returns 204", async () => {
    const chatRes = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Quick question." }),
    });
    const { sessionId } = (await chatRes.json()) as { sessionId: string };
    await waitFor(() => !dispatcher.isSessionRunning(sessionId));

    const delRes = await fetch(
      `http://127.0.0.1:${port}/sessions/${sessionId}`,
      {
        method: "DELETE",
        headers: { Cookie: `nw_auth=${SESSION}` },
      },
    );
    expect(delRes.status).toBe(204);
    expect(getSession(sessionId)).toBeUndefined();
  });

  it("returns 409 and does not delete a session that is currently running", async () => {
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

    const delRes = await fetch(
      `http://127.0.0.1:${port}/sessions/${sessionId}`,
      {
        method: "DELETE",
        headers: { Cookie: `nw_auth=${SESSION}` },
      },
    );
    expect(delRes.status).toBe(409);
    expect(getSession(sessionId)).toBeDefined();

    gateController.releaseAll();
    await waitFor(() => !dispatcher.isSessionRunning(sessionId));
  });
});
