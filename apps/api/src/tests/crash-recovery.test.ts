import { randomUUID } from "node:crypto";
import { seedAlertSession } from "./session-helper.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { NormalizedAlert, TranscriptRow } from "@nightwarden/shared";

vi.mock("../llm/factory.js", () => import("./llm-factory-mock.js"));

import { mockCreateProvider } from "./llm-factory-mock.js";
import { createScriptRunner } from "./contract-fake-provider.js";

const scriptRunner = createScriptRunner();
mockCreateProvider.mockImplementation(() => scriptRunner.create());

import {
  appendRowsAndInterrupt,
  appendTranscriptRows,
  getTranscriptRows,
  isRunning,
  claimRun,
} from "../db/sessions.js";
import { recoverDeadRuns } from "../session/recover.js";
import { buildSeed } from "../session/seed.js";
import { useTempDb } from "./temp-db.js";
import { waitFor } from "./wait.js";

const alert: NormalizedAlert = {
  sourceAlertId: "src-crash",
  labels: {},
  alertType: "ContainerDown",
  severity: "critical",
  firedAt: "2026-06-13T00:00:00.000Z",
  annotations: {},
  generatorURL: null,
  rawPayload: {},
};

// A session that was mid-run when the process died: its row still says running,
// because nothing got the chance to clear it.
function killedRun(rows: TranscriptRow[] = [], at = new Date()): string {
  const sessionId = randomUUID();
  seedAlertSession({ sessionId, title: "t", createdAt: at.toISOString() }, [
    alert,
  ]);
  if (rows.length > 0) appendTranscriptRows(rows);
  claimRun(sessionId);
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
  id: string,
  name: string,
  input: Record<string, unknown>,
): TranscriptRow {
  return turn(sessionId, seq, {
    content: `[tool: ${name}]`,
    parts: [{ type: "tool_call", id, name, input }],
  });
}

describe("recovering runs a restart interrupted", () => {
  let cleanupDb: () => void;

  beforeAll(() => {
    cleanupDb = useTempDb();
  });

  afterAll(() => {
    cleanupDb();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("clears the flag and says it was interrupted, rather than leaving it to read as inconclusive", async () => {
    // Old enough that nothing picks it up, so the record is all that happens.
    const old = new Date(Date.now() - 60 * 60_000);
    const sessionId = killedRun([], old);

    const result = await recoverDeadRuns();

    expect(result.failed).toBe(1);
    expect(result.resumed).toBe(0);
    expect(isRunning(sessionId)).toBe(false);
    const note = getTranscriptRows(sessionId).find((m) => m.kind === "error");
    expect(note?.content).toContain("interrupted");
  });

  it("leaves a session waiting on a human alone: it suspended, it did not die", async () => {
    const sessionId = randomUUID();
    seedAlertSession(
      { sessionId, title: "t", createdAt: new Date().toISOString() },
      [alert],
    );
    // The interrupt row, its transcript rows and the suspended state are written
    // in one transaction, so this means the run parked itself rather than being
    // killed - and it keeps its seat for as long as it waits.
    appendRowsAndInterrupt(
      [callTurn(sessionId, 0, "tu-gated", "RestartDockerService", {})],
      {
        sessionId,
        toolUseId: "tu-gated",
        kind: "approval",
        completedResults: [],
        claimedAt: null,
      },
    );

    const result = await recoverDeadRuns();

    expect(result.failed).toBe(0);
    expect(isRunning(sessionId)).toBe(false);
    expect(getTranscriptRows(sessionId).some((m) => m.kind === "error")).toBe(
      false,
    );
  });

  it("answers a read the crash left hanging instead of discarding the turn", async () => {
    scriptRunner.setScript([{ text: "Done.", toolUses: [] }]);
    const sessionId = killedRun();
    // GetRecentChanges is a read, so running it again is running it again.
    appendTranscriptRows([
      callTurn(sessionId, 0, "tu-read", "GetRecentChanges", {}),
    ]);

    await recoverDeadRuns();

    // The replay runs in a different process, so how it went has to ride the row
    // it writes. No GitHub integration here, so the call answers with a class.
    const answering = getTranscriptRows(sessionId)
      .flatMap((row) => row.parts)
      .find((p) => p.type === "tool_result" && p.toolCallId === "tu-read");
    expect(answering).toBeDefined();
    expect(answering).toHaveProperty("outcome");
    // Answered, so the seed keeps the exchange rather than unwinding past it.
    expect(buildSeed(sessionId).length).toBeGreaterThan(0);
    await waitFor(() => !isRunning(sessionId));
  });

  it("unwinds past a sandbox write it cannot know ran", async () => {
    const sessionId = killedRun();
    appendTranscriptRows([
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

    const answered = getTranscriptRows(sessionId).some((row) =>
      row.parts.some(
        (p) => p.type === "tool_result" && p.toolCallId === "tu-edit",
      ),
    );
    expect(answered).toBe(false);
    // The dead exchange is gone from what the model is handed, and the user turn
    // before it survives, so the resume has the request that started this.
    const seeded = buildSeed(sessionId);
    expect(seeded).toHaveLength(1);
    expect(seeded[0]?.content).toBe("fix it");
    await waitFor(() => !isRunning(sessionId));
  });
});
