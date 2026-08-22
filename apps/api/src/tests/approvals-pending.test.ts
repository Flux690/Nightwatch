import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
import { waitFor } from "./wait.js";

import { registerSessionRoutes } from "../session/routes.js";
import { harness, type Harness } from "./harness.js";
import { registerRunner, unregisterRunner } from "../ws/fleet.js";
import { resolveCommand } from "../ws/command-transport.js";
import type {
  SessionDetail,
  SessionListRow,
  SessionListPage,
  TranscriptItem,
} from "@nightwarden/shared";

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
  let nw: Harness;
  let port: number;
  let SESSION: string;

  beforeAll(async () => {
    nw = await harness({ routes: [registerSessionRoutes] });
    ({ port, session: SESSION } = nw);
  });

  afterAll(async () => {
    await nw.close();
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

    // The call and what it waits on arrive as one item, so the console has
    // nothing to reconcile and nothing to drop. What it needs from the human
    // rides on the state, never on a second label beside it.
    const card = items.find((i) => i.kind === "tool_call");
    expect(card).toBeDefined();
    expect(card?.kind === "tool_call" && card.toolName).toBe(
      "RestartDockerService",
    );
    expect(card?.kind === "tool_call" && card.state).toEqual({
      phase: "awaiting_human",
      gate: "approval",
    });

    await resolvePending(sessionId);
    unregisterRunner(conn);
  });

  it("still shows the decision, and what the tool returned, after the wait ends", async () => {
    const { conn } = connectRunner("after-decision");
    await startGatedChat("decision survives");

    const sessionId = await waitForAwaitingSession();
    await resolvePending(sessionId);

    // The decision has to come from the database rather than the browser that
    // made it, and from what was recorded when the person was asked rather than
    // from the tool's name - which says nothing about whether anyone answered.
    const items = await getTranscript(sessionId);
    const cards = items.filter(
      (i) => i.kind === "tool_call" && i.toolName === "RestartDockerService",
    );
    // One call is one item for its whole life. A settled approval used to keep
    // its own card and grow a second one beneath it for the same call.
    expect(cards).toHaveLength(1);
    /* No outcome: a declined call never ran, so there is nothing to say about
       how the tool behaved. That a person declined it is the decision. */
    expect(cards[0]?.kind === "tool_call" && cards[0].state).toEqual({
      phase: "resolved",
      decision: "rejected",
      result: expect.any(String),
    });

    unregisterRunner(conn);
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
