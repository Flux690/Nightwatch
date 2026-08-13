import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { RunnerCommandMessage } from "@nightwarden/shared";

// Scripted provider: drives the loop to a gated tool so the interrupt row is
// written to the DB, which is what these tests assert against.
vi.mock("../llm/factory.js", () => import("./llm-factory-mock.js"));

import { mockCreateProvider } from "./llm-factory-mock.js";

import {
  createScriptRunner,
  type ScriptedTurn,
} from "./contract-fake-provider.js";

const scriptRunner = createScriptRunner();
mockCreateProvider.mockImplementation(() => scriptRunner.create());
const setScript = (turns: ScriptedTurn[]): void =>
  scriptRunner.setScript(turns);

import { generateRunnerToken } from "../db/runner.js";
import { useTempDb } from "./temp-db.js";
import { mintTestSession } from "./session-helper.js";
import { waitFor } from "./wait.js";

import { registerSessionRoutes } from "../session/routes.js";
import { registerRunner, unregisterRunner } from "../ws/fleet.js";
import { resolveCommand } from "../ws/command-transport.js";
import type {
  SessionDetail,
  SessionListRow,
  SessionListPage,
  TranscriptItem,
} from "@nightwarden/shared";
import { mountApi } from "./api-server.js";

// A free-form text finish: no tool call ends the run successfully.
const FINISH_TURN = {
  text: "Investigation complete.",
  toolUses: [],
};

const RESTART_TURN = (): ScriptedTurn => ({
  text: "Restarting.",
  toolUses: [
    {
      id: `tu-${randomUUID()}`,
      name: "RestartDockerService",
      input: {
        target: "docker/web-01/web-01",
        reason: "r",
        risk: "low",
        estimatedDowntimeSeconds: 1,
      },
    },
  ],
});

describe("a suspended session serves its pending row with its transcript", () => {
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

  function connectRunner(label: string): {
    conn: ReturnType<typeof registerRunner>;
  } {
    const token = generateRunnerToken("docker", label).id;
    const conn = registerRunner({
      runnerId: token,
      platform: "docker",
      send: (raw: string) => {
        const msg = JSON.parse(raw) as RunnerCommandMessage;
        resolveCommand({
          correlationId: msg.payload.correlationId,
          success: true,
          result: [],
        });
      },
      close: () => {},
    });
    return { conn };
  }

  async function startGatedChat(message: string): Promise<void> {
    setScript([RESTART_TURN(), FINISH_TURN]);
    const chatRes = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ message }),
    });
    expect(chatRes.status).toBe(202);
  }

  async function listSessions(): Promise<SessionListRow[]> {
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      headers: { Cookie: `nw_auth=${SESSION}` },
    });
    return ((await r.json()) as SessionListPage).rows;
  }

  async function getTranscript(id: string): Promise<TranscriptItem[]> {
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions/${id}`, {
      headers: { Cookie: `nw_auth=${SESSION}` },
    });
    return ((await r.json()) as SessionDetail).transcript;
  }

  // The session id is discovered the way the console discovers it: from the list.
  async function waitForAwaitingSession(): Promise<string> {
    return waitFor(async () => {
      const rows = await listSessions();
      return rows.find((s) => s.awaitingHumanInput)?.sessionId ?? null;
    });
  }

  async function resolvePending(sessionId: string): Promise<void> {
    await fetch(`http://127.0.0.1:${port}/api/sessions/${sessionId}/respond`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `nw_auth=${SESSION}`,
      },
      body: JSON.stringify({ decision: "reject" }),
    });
  }

  it("projects the suspended tool call as a card awaiting a human", async () => {
    const { conn } = connectRunner("qa");
    await startGatedChat("test");

    const sessionId = await waitForAwaitingSession();
    const items = await getTranscript(sessionId);

    // The card and the decision it waits on arrive as one item, so the console
    // has nothing to reconcile and nothing to drop.
    const card = items.find((i) => i.kind === "approval_card");
    expect(card).toBeDefined();
    expect(card?.kind === "approval_card" && card.toolName).toBe(
      "RestartDockerService",
    );
    expect(card?.kind === "approval_card" && card.state.phase).toBe(
      "awaiting_human",
    );

    await resolvePending(sessionId);
    unregisterRunner(conn);
  });

  it("still shows the decision, and what the tool returned, after the wait ends", async () => {
    const { conn } = connectRunner("after-decision");
    await startGatedChat("decision survives");

    const sessionId = await waitForAwaitingSession();
    await resolvePending(sessionId);

    // Reloading is the only way a user sees a finished investigation, so the
    // decision has to be reconstructible from the database, not from the browser
    // that made it. Nothing stores it: the registry says the call was gated and
    // the outcome says it was declined.
    const items = await getTranscript(sessionId);
    const card = items.find((i) => i.kind === "approval_card");
    expect(card?.kind === "approval_card" && card.state).toMatchObject({
      phase: "resolved",
      decision: "rejected",
      outcome: "rejected",
    });

    unregisterRunner(conn);
  });

  it("returns 401 without a valid nw_auth cookie", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/any-id`);
    expect(res.status).toBe(401);
  });

  it("flags the waiting session user-wide, whichever runner produced it", async () => {
    const { conn } = connectRunner("scope-c");
    await startGatedChat("scope test");

    // No token parameter anywhere: the user sees every waiting session.
    const sessionId = await waitForAwaitingSession();
    expect(sessionId).toBeTruthy();

    await resolvePending(sessionId);
    unregisterRunner(conn);
  });

  it("clears pending and the awaiting flag once resolved", async () => {
    const { conn } = connectRunner("empty-after");
    await startGatedChat("empty after resolve");

    const sessionId = await waitForAwaitingSession();
    await resolvePending(sessionId);

    await waitFor(async () => {
      const rows = await listSessions();
      const row = rows.find((s) => s.sessionId === sessionId);
      return row && !row.awaitingHumanInput ? true : null;
    });

    const items = await getTranscript(sessionId);
    expect(
      items.some((i) => "state" in i && i.state.phase === "awaiting_human"),
    ).toBe(false);

    unregisterRunner(conn);
  });
});
