import type { Platform } from "@nightwarden/shared";
import type { ToolSchema } from "../../llm/types.js";

export interface ToolExecuteResult {
  content: unknown;
  is_error?: boolean;
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
// being the operator's ceiling already clamped by what remains of the run.
export interface ToolDispatchContext extends ToolCallIdentity {
  toolCallCeilingMs: number;
}

// What a tool is handed: the limit resolved for this one call. Distinct from
// the ceiling above so neither can be mistaken for the other.
export interface ToolExecuteContext extends ToolCallIdentity {
  toolTimeoutMs: number;
}

interface ToolCommon {
  schema: ToolSchema;
  access: "read" | "write" | "ask";
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
