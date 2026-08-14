import type { EvidenceKind, Platform, ToolOutcome } from "@nightwarden/shared";
import type { ToolSchema } from "../../llm/types.js";

export interface ToolExecuteResult {
  content: unknown;
  // Absent means the call answered. Every failure path names its class instead
  // of a boolean, and the wire's is_error is derived from it below, so the two
  // can never disagree about whether something went wrong.
  outcome?: ToolOutcome;
}

// What the dispatcher hands back: the result already rendered to the string the
// model reads, and already bounded, so no caller can enter context past the cap.
export interface DispatchedToolResult {
  content: string;
  outcome?: ToolOutcome;
}

// A fan-out where some runners answered still carries an answer; everything
// else the model must read as an error.
export function isToolFailure(outcome: ToolOutcome | undefined): boolean {
  return outcome !== undefined && outcome !== "partial";
}

interface ToolCallIdentity {
  // Session-scoped: repo tools key their sandbox workspace on it. Tools stay
  // stateless; the sandbox module owns all bookkeeping.
  sessionId: string;
  // The tool_use id of this call: OpenPullRequest keys its write-ahead audit row on
  // (sessionId, toolUseId), the same idempotency the approval path uses.
  toolUseId: string;
}

// What a caller hands the dispatcher: the upper bound this call may not exceed,
// being the user's ceiling already clamped by what remains of the run.
export interface ToolDispatchContext extends ToolCallIdentity {
  toolCallCeilingMs: number;
}

// What a tool is handed: the limit resolved for this one call. Distinct from
// the ceiling above so neither can be mistaken for the other.
export interface ToolExecuteContext extends ToolCallIdentity {
  toolTimeoutMs: number;
}

// Two facts, not one: a write can be safe for where it lands, so a tool that
// overrides the write -> approve default says why on its entry.
export type ToolPolicy = "auto" | "approve";

interface ToolCommon {
  schema: ToolSchema;
  effect: "read" | "write";
  policy: ToolPolicy;
  /* What a citation of this call is worth showing as. Required, and declared
     here rather than in a lookup table beside it, for the reason `policy` is:
     a separate list is a list that can be forgotten when a tool is added, and
     the report would then draw new evidence as plain text without anyone
     noticing. */
  evidenceKind: EvidenceKind;
  // A write safe to run twice, which is what lets a call caught by a crash be
  // replayed instead of unwound. Only ever true where the tool says why.
  idempotent?: true;
  // Per-tool override of the global tool timeout: repo tools run clones,
  // installs and test suites, which dwarf the 15s default.
  timeoutMs?: number;
}

// Where a tool executes is declared, never inferred. A service-routed command finds its
// owner from the target key; a runner-routed one names its platform, so a fan-out
// reaches only runners of that platform.
export type Tool = ToolCommon &
  (
    | {
        on: "api";
        execute(
          input: Record<string, unknown>,
          ctx: ToolExecuteContext,
        ): Promise<ToolExecuteResult>;
      }
    | { on: "runner"; routeBy: "service" }
    | { on: "runner"; routeBy: "runner"; platform: Platform }
  );
