import type { TranscriptRow } from "@nightwarden/shared";
import { isCitable, type RecordGap } from "../report.js";
import { recordGapsMessage, recordCheck } from "../prompts/report.js";
import { offeredSchemas, type OfferedToolset } from "../tools/toolset.js";
import type { ToolResult, ToolUse } from "../../llm/types.js";

// Per gap kind, so a run stuck on one gap cannot spend another gap's allowance.
// The time budget bounds it as well.
const MAX_FINISH_PUSHBACKS = 3;

// Null once the kind's cap is spent, which writes the report up incomplete.
export type FinishGate = (gaps: RecordGap[]) => {
  say: string;
  kind: RecordGap["kind"];
  count: number;
} | null;

export function finishGatePolicy(
  spent: Record<RecordGap["kind"], number>,
): FinishGate {
  const counts: Record<RecordGap["kind"], number> = { ...spent };
  return (gaps) => {
    for (const gap of gaps) {
      if (counts[gap.kind] >= MAX_FINISH_PUSHBACKS) continue;
      counts[gap.kind] += 1;
      return {
        say: recordGapsMessage([gap]),
        kind: gap.kind,
        count: counts[gap.kind],
      };
    }
    return null;
  };
}

// Consecutive turns that asked for nothing but unavailable tools. Three is
// enough to tell a wrong guess from a model with nothing left to try.
const MAX_BARREN_TURNS = 3;

// The toolset rides in because it changes mid-run and the ending names it.
export type BarrenTurns = (
  asked: number,
  refused: number,
  offered: OfferedToolset,
) => string | null;

/* A turn of nothing but unavailable tools gets nothing done, and the model
   cannot see it is looping, so only the time budget would stop it. */
export function barrenTurnPolicy(): BarrenTurns {
  let barren = 0;
  return (asked, refused, offered) => {
    barren = refused === asked ? barren + 1 : 0;
    if (barren < MAX_BARREN_TURNS) return null;
    return `The last ${barren} turns asked only for tools this investigation does not have, so the run was ended rather than spend its budget repeating them. What was available: ${offeredSchemas(
      offered,
    )
      .map((t) => t.name)
      .join(", ")}.`;
  };
}

// Past orientation and long before the budget matters. A check, not a repair:
// nothing has failed, the run has simply read a lot and settled none of it.
const CALLS_BEFORE_RECORD_CHECK = 8;

// Every check is a durable row the seed replays, so a run that never records
// is bounded rather than asked for the rest of it.
const MAX_RECORD_CHECKS = 3;

export interface RecordDebt {
  // Takes the record's own claim count, so a claim recorded this turn clears
  // the debt before this turn's reads are counted against it.
  check: (claims: number, answered: number) => string | null;
}

/* Recording is what clears the debt, so a run that settles something early and
   then reads on is asked again. */
export function recordDebtPolicy(
  investigation: boolean,
  spent: number,
): RecordDebt {
  let sinceClaim = 0;
  let claimsSeen = 0;
  // The debt when the check last spoke, so it asks again after another eight
  // rather than every turn.
  let checkedAt = 0;
  let checks = spent;
  return {
    check: (claims, answered) => {
      if (claims > claimsSeen) {
        claimsSeen = claims;
        sinceClaim = 0;
        checkedAt = 0;
      }
      sinceClaim += answered;
      if (!investigation || checks >= MAX_RECORD_CHECKS) return null;
      if (sinceClaim - checkedAt < CALLS_BEFORE_RECORD_CHECK) return null;
      checks++;
      checkedAt = sinceClaim;
      return recordCheck(sinceClaim);
    },
  };
}

// What earlier runs on this session already spent, read off the turns they sent.
export function spentOn(
  rows: readonly TranscriptRow[],
  opening: string,
): number {
  return rows.filter(
    (r) => r.kind === "system_reminder" && r.content.includes(opening),
  ).length;
}

// Read from the turn, because a harness turn orphans a tool_use from its result.
export function citableIds(uses: readonly ToolUse[]): Set<string> {
  return new Set(
    uses.filter((t) => isCitable(t.name)).map((t) => t.toolCallId),
  );
}

// Calls that answered and could back a claim; a refused one taught nothing.
export function citableAnswers(
  uses: readonly ToolUse[],
  results: readonly ToolResult[],
): number {
  const citable = citableIds(uses);
  return results.filter((r) => r.isError !== true && citable.has(r.toolCallId))
    .length;
}
