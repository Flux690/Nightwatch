import type { Verdict } from "@nightwarden/shared";
import { checkLLMReadiness } from "../../config/readiness.js";
import {
  PROPOSE_FIX_SCHEMA,
  PROPOSE_HYPOTHESIS_SCHEMA,
  RESOLVE_HYPOTHESIS_SCHEMA,
} from "../prompts/report.js";
import {
  proposeFix,
  proposeHypothesis,
  resolveHypothesis,
  type RecordOutcome,
} from "../report.js";
import type { Tool, ToolExecuteResult } from "./types.js";

// Thin adapters over the report domain service. Offered only to a session under
// investigation; the toolset gates them out of every other run.

// "open" is the state a hypothesis is born in, not something it can be settled
// on, so it is the one verdict this tool does not accept.
const VERDICTS: Exclude<Verdict, "open">[] = [
  "root_cause",
  "trigger",
  "symptom",
  "contributing_factor",
  "disproven",
];
function isVerdict(value: unknown): value is Exclude<Verdict, "open"> {
  return VERDICTS.some((v) => v === value);
}

// A run cannot start unconfigured, so the active provider's model is set by the
// time any tool executes; the fallback only keeps attribution honest.
function activeModel(): string {
  const readiness = checkLLMReadiness();
  return readiness.ready ? readiness.config.model : "unknown";
}

// Prose the record cannot do without. A blank one is the model skipping the
// field, which stores a row nobody can read.
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function citations(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((id) => typeof id === "string") ? value : null;
}

// Defensive seatbelt behind the provider's schema enforcement; a corrupt call
// gets a corrective tool error instead of a corrupt stored record.
function malformed(message: string): ToolExecuteResult {
  return { content: message, outcome: "system" };
}

// A refusal is the record holding its ground, not a fault: the tool worked and
// what was asked for is not available.
function toResult(outcome: RecordOutcome): ToolExecuteResult {
  return outcome.recorded
    ? { content: outcome.message }
    : { content: outcome.message, outcome: "expected_miss" };
}

export const REPORT_TOOLS: Tool[] = [
  {
    schema: PROPOSE_HYPOTHESIS_SCHEMA,
    access: "read",
    on: "api",
    execute: async (input, ctx): Promise<ToolExecuteResult> => {
      const statement = text(input["statement"]);
      if (statement === null) {
        return malformed("A hypothesis needs a statement. Send one sentence.");
      }
      return toResult(
        proposeHypothesis(ctx.sessionId, activeModel(), statement),
      );
    },
  },
  {
    schema: RESOLVE_HYPOTHESIS_SCHEMA,
    access: "read",
    on: "api",
    execute: async (input, ctx): Promise<ToolExecuteResult> => {
      const id = text(input["id"]);
      const verdict = input["verdict"];
      const finding = input["finding"];
      const evidenceIds = citations(input["evidenceIds"]);
      if (id === null || typeof finding !== "string" || !isVerdict(verdict)) {
        return malformed(
          `Resolving a hypothesis needs its id, a finding, and one of these verdicts: ${VERDICTS.join(", ")}.`,
        );
      }
      if (evidenceIds === null || evidenceIds.length === 0) {
        return malformed(
          "A verdict needs at least one citation. Pass the ids of the tool calls whose results settled this hypothesis.",
        );
      }
      return toResult(
        resolveHypothesis(ctx.sessionId, activeModel(), {
          id,
          verdict,
          finding,
          evidenceIds,
        }),
      );
    },
  },
  {
    schema: PROPOSE_FIX_SCHEMA,
    access: "read",
    on: "api",
    execute: async (input, ctx): Promise<ToolExecuteResult> => {
      const summary = text(input["summary"]);
      const evidenceIds = citations(input["evidenceIds"]);
      if (summary === null || evidenceIds === null) {
        return malformed(
          "A proposed fix needs a summary and an evidenceIds array, which may be empty.",
        );
      }
      return toResult(
        proposeFix(ctx.sessionId, activeModel(), summary, evidenceIds),
      );
    },
  },
];
