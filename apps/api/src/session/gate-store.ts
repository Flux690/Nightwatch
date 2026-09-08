import { getDb } from "../db.js";
import { refreshSessionStatus } from "./status-store.js";
import type { ToolResult } from "../llm/types.js";

// The gate a session is parked on: four columns on its own row, since there is
// at most one. What a person decided lives on the transcript, which is durable.
export interface PendingHumanInput {
  sessionId: string;
  toolCallId: string;
  kind: "approval" | "clarification" | "continue";
  completedResults: ToolResult[];
  claimedAt?: string | null;
}

interface RawRow {
  sessionId: string;
  toolCallId: string | null;
  kind: string | null;
  completedResults: string;
  claimedAt: string | null;
}

export function isHumanInputKind(
  kind: string,
): kind is PendingHumanInput["kind"] {
  return kind === "approval" || kind === "clarification" || kind === "continue";
}

// Untrusted on read despite being our own UPDATE (partial write, schema drift):
// fail loudly on a bad kind or JSON rather than crashing deep in the resume path.
function parseRow(row: RawRow): PendingHumanInput | undefined {
  if (row.toolCallId === null || row.kind === null) return undefined;
  if (!isHumanInputKind(row.kind)) {
    throw new Error(
      `sessions(${row.sessionId}) has unknown awaiting_kind "${row.kind}"`,
    );
  }
  let completedResults: ToolResult[];
  try {
    completedResults = JSON.parse(row.completedResults) as ToolResult[];
  } catch (err) {
    throw new Error(
      `sessions(${row.sessionId}) has corrupt awaiting_results: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return {
    sessionId: row.sessionId,
    toolCallId: row.toolCallId,
    kind: row.kind,
    completedResults,
    claimedAt: row.claimedAt,
  };
}

// Claiming stamps when an attempt began, which is what a boot after a crash
// reads to tell "nobody answered" from "a write may already have run".
export async function claimPendingHumanInput(
  sessionId: string,
): Promise<boolean> {
  const res = await getDb()
    .updateTable("sessions")
    .set({ attempt_started_at: new Date().toISOString() })
    .where("session_id", "=", sessionId)
    .where("awaiting_tool_use_id", "is not", null)
    .where("attempt_started_at", "is", null)
    .executeTakeFirst();
  return Number(res.numUpdatedRows) > 0;
}

export async function deletePendingHumanInput(
  sessionId: string,
): Promise<boolean> {
  const res = await getDb()
    .updateTable("sessions")
    .set({
      awaiting_tool_use_id: null,
      awaiting_kind: null,
      awaiting_results: "[]",
      attempt_started_at: null,
    })
    .where("session_id", "=", sessionId)
    .where("awaiting_tool_use_id", "is not", null)
    .executeTakeFirst();
  if (Number(res.numUpdatedRows) === 0) return false;
  // Nothing is being asked any more, so 'action_required' has stopped being true.
  await refreshSessionStatus(sessionId);
  return true;
}

export async function getPendingHumanInputBySessionId(
  sessionId: string,
): Promise<PendingHumanInput | undefined> {
  const row = await getDb()
    .selectFrom("sessions")
    .select([
      "session_id as sessionId",
      "awaiting_tool_use_id as toolCallId",
      "awaiting_kind as kind",
      "awaiting_results as completedResults",
      "attempt_started_at as claimedAt",
    ])
    .where("session_id", "=", sessionId)
    .executeTakeFirst();
  return row ? parseRow(row) : undefined;
}

export async function hasPendingHumanInput(
  sessionId: string,
): Promise<boolean> {
  const row = await getDb()
    .selectFrom("sessions")
    .select("session_id")
    .where("session_id", "=", sessionId)
    .where("awaiting_tool_use_id", "is not", null)
    .executeTakeFirst();
  return row !== undefined;
}
