import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { harness, type Harness } from "./harness.js";
import { mountApi } from "./api-server.js";
import type { SessionDetail } from "@nightwarden/shared";

vi.mock("../llm/factory.js", () => import("./llm-factory-mock.js"));

import { mockCreateProvider } from "./llm-factory-mock.js";

import {
  createScriptRunner,
  type ContractFakeProvider,
} from "./contract-fake-provider.js";

const script = createScriptRunner();
mockCreateProvider.mockImplementation(() => script.create());

import { waitFor } from "./wait.js";
import { connectConsoleEvents } from "./console-events-helper.js";
import { registerConsoleEventRoutes } from "../session/events.js";
import { registerSessionRoutes } from "../session/routes.js";

describe("console SSE pipeline", () => {
  let nw: Harness;
  let port: number;
  let SESSION: string;

  beforeAll(async () => {
    nw = await harness({
      routes: [registerConsoleEventRoutes, registerSessionRoutes],
      runners: [{ name: "sse-host", services: ["web-01"] }],
    });
    ({ port, session: SESSION } = nw);
  });

  afterAll(async () => {
    await nw.close();
  });

  it("delivers delta events then RUN_FINISHED, transcript loadable after", async () => {
    script.setScript([{ toolUses: [], text: "All looks well." }]);
    const { events, close } = await connectConsoleEvents(port, SESSION);

    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Is the system healthy?" }),
    });
    expect(res.status).toBe(202);
    const { sessionId } = (await res.json()) as { sessionId: string };
    expect(typeof sessionId).toBe("string");

    // The scripted run can resolve in microtasks before this sessionId is captured,
    // so buffer every event and poll for the match rather than racing.
    await waitFor(() =>
      events.some(
        (e) =>
          e.type === "RUN_FINISHED" && e.payload["sessionId"] === sessionId,
      ),
    );

    close();

    const deltas = events.filter(
      (e) =>
        e.type === "TEXT_MESSAGE_CONTENT" &&
        e.payload["sessionId"] === sessionId,
    );
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas[0]?.payload["delta"]).toBe("All looks well.");

    const messages = events.filter(
      (e) => e.type === "MESSAGE" && e.payload["sessionId"] === sessionId,
    );
    expect(messages.length).toBeGreaterThan(0);

    // The terminal event fires exactly once for the whole run, no matter how many
    // messages were flushed - this is what keeps the console's run state stable.
    const finishes = events.filter(
      (e) => e.type === "RUN_FINISHED" && e.payload["sessionId"] === sessionId,
    );
    expect(finishes.length).toBe(1);

    const transcriptRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}`,
      { headers: { Cookie: `nw_auth=${SESSION}` } },
    );
    expect(transcriptRes.status).toBe(200);
    const session = (await transcriptRes.json()) as SessionDetail;
    expect(session.transcript.length).toBeGreaterThan(0);
  });

  it("resume of ended session seeds provider from persisted transcript", async () => {
    mockCreateProvider.mockClear();
    script.setScript([
      { toolUses: [], text: "All looks well." },
      { toolUses: [], text: "Still healthy." },
    ]);

    const { events, close } = await connectConsoleEvents(port, SESSION);

    // Each run persists exactly one assistant turn, so counting assistant MESSAGE
    // events distinguishes the first run (>=1) from the resumed run (>=2).
    const assistantFinishes = (sessionId: string): number =>
      events.filter((e) => {
        const payload = e.payload as {
          sessionId?: string;
          message?: { kind?: string };
        };
        return (
          e.type === "MESSAGE" &&
          payload.sessionId === sessionId &&
          payload.message?.kind === "assistant"
        );
      }).length;

    const startRes = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message: "Is the system healthy?" }),
    });
    expect(startRes.status).toBe(202);
    const { sessionId } = (await startRes.json()) as { sessionId: string };

    await waitFor(() => assistantFinishes(sessionId) >= 1);

    // Resume the ended session with a follow-up message. The same sessionId
    // must come back - no new session is minted.
    const resumeRes = await fetch(
      `http://127.0.0.1:${port}/api/sessions/${sessionId}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nw_auth=${SESSION}`,
        },
        body: JSON.stringify({ message: "Follow-up question." }),
      },
    );
    expect(resumeRes.status).toBe(202);
    const resumeBody = (await resumeRes.json()) as { sessionId: string };
    expect(resumeBody.sessionId).toBe(sessionId);

    // The resumed run must emit a second assistant RUN_FINISHED (i.e. the new
    // turns are persisted - if snapshot() were not stateful this would time out).
    await waitFor(() => assistantFinishes(sessionId) >= 2);

    close();

    // createProvider was called once per run.
    expect(mockCreateProvider.mock.calls.length).toBe(2);

    // The resume provider must be seeded with the first run's persisted messages,
    // then have the follow-up appended as a user turn.
    const resumeProvider = mockCreateProvider.mock.results[1]
      ?.value as ContractFakeProvider;
    expect(resumeProvider.seed).toHaveBeenCalledOnce();
    const [seededHistory] = resumeProvider.seed.mock.calls[0] as [
      Array<{ role: string; content: string }>,
    ];
    expect(seededHistory).toHaveLength(2);
    expect(seededHistory[0]).toMatchObject({ role: "user" });
    expect(seededHistory[1]).toMatchObject({ role: "assistant" });
    expect(resumeProvider.appendUserMessage).toHaveBeenCalledWith(
      "Follow-up question.",
    );
  });

  it("sends heartbeat comments on the configured interval", async () => {
    const hb = Fastify({ logger: false, forceCloseConnections: true });
    await mountApi(hb, (api: FastifyInstance) =>
      registerConsoleEventRoutes(api, { heartbeatInterval: 50 }),
    );
    await hb.listen({ port: 0, host: "127.0.0.1" });
    const hbPort = (hb.server.address() as AddressInfo).port;

    const { comments, close } = await connectConsoleEvents(hbPort, SESSION);
    await waitFor(() => comments.some((c) => c.includes("heartbeat")));

    close();
    await hb.close();
  });
});
