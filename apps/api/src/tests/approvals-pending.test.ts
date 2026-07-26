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
import {
  registerRunner,
  unregisterRunner,
  setRunnerRemediationMode,
} from "../ws/fleet.js";
import { resolveCommand } from "../ws/command-transport.js";
import type { SessionListRow, SessionTranscript } from "@nightwarden/shared";
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
        rationale: "r",
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
    const token = generateRunnerToken(label).id;
    const conn = registerRunner(
      token,
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
    // Remediation on so the write tool is offered (chat reads the live fleet).
    setRunnerRemediationMode(token, true);
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
    return (await r.json()) as SessionListRow[];
  }

  async function getTranscript(id: string): Promise<SessionTranscript> {
    const r = await fetch(`http://127.0.0.1:${port}/api/sessions/${id}`, {
      headers: { Cookie: `nw_auth=${SESSION}` },
    });
    return (await r.json()) as SessionTranscript;
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
      body: JSON.stringify({ decision: "reject", resolvedBy: "cleanup" }),
    });
  }

  it("serves the pending row with the transcript in one response", async () => {
    const { conn } = connectRunner("qa");
    await startGatedChat("test");

    const sessionId = await waitForAwaitingSession();
    const transcript = await getTranscript(sessionId);

    // One response carries both, so the console never reconciles two lists.
    expect(transcript.messages.length).toBeGreaterThan(0);
    expect(transcript.pending).not.toBeNull();
    expect(transcript.pending?.toolName).toBe("RestartDockerService");
    expect(transcript.pending?.status).toBe("pending");
    expect(transcript.pending?.sessionId).toBe(sessionId);

    await resolvePending(sessionId);
    unregisterRunner(conn);
  });

  it("returns 401 without a valid nw_auth cookie", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/any-id`);
    expect(res.status).toBe(401);
  });

  it("flags the waiting session operator-wide, whichever runner produced it", async () => {
    const { conn } = connectRunner("scope-c");
    await startGatedChat("scope test");

    // No token parameter anywhere: the operator sees every waiting session.
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

    const transcript = await getTranscript(sessionId);
    expect(transcript.pending).toBeNull();

    unregisterRunner(conn);
  });
});
