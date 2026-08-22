import { harness, type Harness } from "./harness.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../llm/factory.js", () => import("./llm-factory-mock.js"));

import { mockCreateProvider } from "./llm-factory-mock.js";

import {
  createContractFakeProvider,
  createGateController,
} from "./contract-fake-provider.js";

mockCreateProvider.mockImplementation(() =>
  createContractFakeProvider([{ toolUses: [], text: "Done." }]),
);

import { waitFor } from "./wait.js";

import { registerSessionRoutes } from "../session/routes.js";
import { dispatcher } from "../dispatcher.js";
import { getSession } from "../db/sessions.js";
import { seedCompleteReport } from "./report-helper.js";

describe("DELETE /sessions/:id", () => {
  let nw: Harness;
  let port: number;
  let SESSION: string;

  beforeAll(async () => {
    nw = await harness({ routes: [registerSessionRoutes] });
    ({ port } = nw);
    SESSION = nw.session;
  });

  afterAll(async () => {
    await nw.close();
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
