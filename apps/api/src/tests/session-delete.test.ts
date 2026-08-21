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

import { useTempDb } from "./temp-db.js";
import { mintTestSession } from "./session-helper.js";
import { waitFor } from "./wait.js";

import { registerSessionRoutes } from "../session/routes.js";
import { dispatcher } from "../dispatcher.js";
import { getSession } from "../db/sessions.js";
import { seedCompleteReport } from "./report-helper.js";
import { mountApi } from "./api-server.js";

describe("DELETE /sessions/:id", () => {
  let server: FastifyInstance;
  let port: number;
  let cleanupDb: () => void;
  let SESSION: string;

  beforeAll(async () => {
    cleanupDb = useTempDb();
    SESSION = await mintTestSession();

    server = Fastify({ logger: false });
    await mountApi(server, registerSessionRoutes);
    await server.listen({ port: 0, host: "127.0.0.1" });
    port = (server.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await server.close();
    cleanupDb();
    vi.unstubAllEnvs();
  });

  it("deletes a finished session and returns 204", async () => {
    const chatRes = await fetch(`http://127.0.0.1:${port}/api/chat`, {
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
      `http://127.0.0.1:${port}/api/sessions/${sessionId}`,
      {
        method: "DELETE",
        headers: { Cookie: `nw_auth=${SESSION}` },
      },
    );
    expect(delRes.status).toBe(204);
    expect(getSession(sessionId)).toBeUndefined();
  });

  it("leaves no report behind: the report route 404s once the session is gone", async () => {
    const chatRes = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "What happened here?" }),
    });
    const { sessionId } = (await chatRes.json()) as { sessionId: string };
    await waitFor(() => !dispatcher.isSessionRunning(sessionId));
    seedCompleteReport(sessionId);

    const before = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/report`,
      { headers: { Cookie: `nw_auth=${SESSION}` } },
    );
    expect(before.status).toBe(200);

    await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}`, {
      method: "DELETE",
      headers: { Cookie: `nw_auth=${SESSION}` },
    });

    const after = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/report`,
      { headers: { Cookie: `nw_auth=${SESSION}` } },
    );
    expect(after.status).toBe(404);
  });

  it("returns 409 and does not delete a session that is currently running", async () => {
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

    const delRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}`,
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
