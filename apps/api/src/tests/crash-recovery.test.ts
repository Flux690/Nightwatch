import { randomUUID } from "node:crypto";
import { seedAlertSession } from "./session-helper.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { NormalizedAlert, TranscriptRow } from "@nightwarden/shared";

vi.mock("../llm/factory.js", () => import("./llm-factory-mock.js"));

import { mockCreateProvider } from "./llm-factory-mock.js";
import { createScriptRunner } from "./contract-fake-provider.js";

const scriptRunner = createScriptRunner();
mockCreateProvider.mockImplementation(() => scriptRunner.create());

import { claimRun, isRunning } from "../session/status-store.js";
import {
  appendRowsAndPark,
  appendTranscriptRows,
  getTranscriptRows,
} from "../session/transcript-store.js";
import { recoverDeadRuns } from "../session/recover.js";
import { buildSeed } from "../session/seed.js";
import { useTempDb } from "./temp-db.js";
import { waitFor } from "./wait.js";

const alert: NormalizedAlert = {
  sourceAlertId: "src-crash",
  labels: {},
  alertType: "ContainerDown",
  firedAt: "2026-06-13T00:00:00.000Z",
  annotations: {},
  generatorURL: null,
  values: {},
};

// A session that was mid-run when the process died: its row still says running,
// because nothing got the chance to clear it.
async function killedRun(
  rows: TranscriptRow[] = [],
  at = new Date(),
): Promise<string> {
  const sessionId = randomUUID();
  await seedAlertSession(
    { sessionId, title: "t", createdAt: at.toISOString() },
    [alert],
  );
  if (rows.length > 0) await appendTranscriptRows(rows);
  await claimRun(sessionId);
  return sessionId;
}

function turn(
  sessionId: string,
  seq: number,
  overrides: Partial<TranscriptRow> = {},
): TranscriptRow {
  return {
    sessionId,
    seq,
    kind: "assistant",
    content: "working",
    parts: [{ type: "text", text: "working" }],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function callTurn(
  sessionId: string,
  seq: number,
  toolCallId: string,
  name: string,
  input: Record<string, unknown>,
): TranscriptRow {
  return turn(sessionId, seq, {
    content: `[tool: ${name}]`,
    parts: [{ type: "tool_call", toolCallId, name, input }],
  });
}

describe("recovering runs a restart interrupted", () => {
  let cleanupDb: () => void;

  beforeAll(async () => {
    cleanupDb = await useTempDb();
  });

  afterAll(() => {
    cleanupDb();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("clears the flag and says it was interrupted, rather than leaving it to read as a run that concluded nothing", async () => {
    // Old enough that nothing picks it up, so the record is all that happens.
    const old = new Date(Date.now() - 60 * 60_000);
    const sessionId = await killedRun([], old);

    const result = await recoverDeadRuns();

    expect(result.failed).toBe(1);
    expect(result.resumed).toBe(0);
    expect(await isRunning(sessionId)).toBe(false);
    const note = (await getTranscriptRows(sessionId)).find(
      (m) => m.kind === "error",
    );
    expect(note?.content).toContain("interrupted");
  });

  it("leaves a session waiting on a human alone: it suspended, it did not die", async () => {
    const sessionId = randomUUID();
    await seedAlertSession(
      { sessionId, title: "t", createdAt: new Date().toISOString() },
      [alert],
    );
    // All three are written in one transaction, so this means the run parked
    // itself rather than being killed, and it keeps its seat while it waits.
    await appendRowsAndPark(
      [callTurn(sessionId, 0, "tu-gated", "RestartDockerService", {})],
      {
        sessionId,
        toolCallId: "tu-gated",
        kind: "approval",
        completedResults: [],
        claimedAt: null,
      },
    );

    const result = await recoverDeadRuns();

    expect(result.failed).toBe(0);
    expect(await isRunning(sessionId)).toBe(false);
    expect(
      (await getTranscriptRows(sessionId)).some((m) => m.kind === "error"),
    ).toBe(false);
  });

  it("answers a read the crash left hanging instead of discarding the turn", async () => {
    scriptRunner.setScript([{ text: "Done.", toolUses: [] }]);
    const sessionId = await killedRun();
    // GetRecentChanges is a read, so running it again is running it again.
    await appendTranscriptRows([
      callTurn(sessionId, 0, "tu-read", "GetRecentChanges", {}),
    ]);

    await recoverDeadRuns();

    // The replay runs in a different process, so how it went has to ride the row
    // it writes. No GitHub integration here, so the call answers with a class.
    const answering = await (
      await getTranscriptRows(sessionId)
    )
      .flatMap((row) => row.parts)
      .find((p) => p.type === "tool_result" && p.toolCallId === "tu-read");
    expect(answering).toBeDefined();
    expect(answering).toHaveProperty("isError");
    // Answered, so the seed keeps the exchange rather than unwinding past it.
    expect((await buildSeed(sessionId)).length).toBeGreaterThan(0);
    await waitFor(async () => !(await isRunning(sessionId)));
  });

  it("unwinds past a sandbox write it cannot know ran", async () => {
    const sessionId = await killedRun();
    await appendTranscriptRows([
      turn(sessionId, 0, {
        kind: "user",
        content: "fix it",
        parts: [{ type: "text", text: "fix it" }],
      }),
      callTurn(sessionId, 1, "tu-edit", "Edit", {
        path: "a.ts",
        old_string: "x",
        new_string: "y",
      }),
    ]);

    await recoverDeadRuns();

    const answered = (await getTranscriptRows(sessionId)).some((row) =>
      row.parts.some(
        (p) => p.type === "tool_result" && p.toolCallId === "tu-edit",
      ),
    );
    expect(answered).toBe(false);
    // The dead exchange is gone from what the model is handed, and the user turn
    // before it survives, so the resume has the request that started this.
    const seeded = await buildSeed(sessionId);
    expect(seeded).toHaveLength(1);
    expect(seeded[0]?.content).toBe("fix it");
    await waitFor(async () => !(await isRunning(sessionId)));
  });

  // A gated call is unanswered until a human decides, so unwinding past it hands
  // the model results for a call it can no longer see it made.
  it("keeps a gated turn once its answer is on the record", async () => {
    const sessionId = await killedRun();
    await appendTranscriptRows([
      turn(sessionId, 0, {
        kind: "user",
        content: "restart it",
        parts: [{ type: "text", text: "restart it" }],
      }),
      turn(sessionId, 1, {
        content: "[tool: RestartDockerService]",
        parts: [
          {
            type: "tool_call",
            toolCallId: "tu-read",
            name: "ListDockerServices",
            input: {},
          },
          {
            type: "tool_call",
            toolCallId: "tu-gate",
            name: "RestartDockerService",
            input: { target: "prod-1/web/api" },
          },
        ],
      }),
    ]);

    // Nobody has answered, so the turn is dropped: this is the crash case.
    expect(await buildSeed(sessionId)).toHaveLength(1);

    // Resolving a gate writes the whole turn's results before it clears, so the
    // seed finds the exchange answered on the transcript.
    await appendTranscriptRows([
      turn(sessionId, 2, {
        kind: "user",
        content: "results",
        parts: [
          { type: "tool_result", toolCallId: "tu-read", output: "ok" },
          { type: "tool_result", toolCallId: "tu-gate", output: "restarted" },
        ],
      }),
    ]);

    const resumed = await buildSeed(sessionId);
    expect(resumed).toHaveLength(3);
    expect(resumed[1]?.parts.map((p) => p.type)).toEqual([
      "tool_call",
      "tool_call",
    ]);
  });
});
