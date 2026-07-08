import type { ToolSchema } from "../../llm/types.js";
import type { CommandRoute } from "../../ws/router.js";

export type Provider = "docker" | "kubernetes";

export interface ToolExecuteResult {
  content: unknown;
  is_error?: boolean;
}

export interface ToolExecuteContext {
  toolTimeoutMs: number;
  // Session-scoped: repo tools key their sandbox workspace on it. Tools stay
  // stateless; the sandbox module owns all bookkeeping.
  sessionId: string;
  // The tool_use id of this call: open_pull_request keys its write-ahead
  // audit row on (sessionId, toolUseId), the same idempotency the approval
  // path uses.
  toolUseId: string;
}

interface ToolCommon {
  schema: ToolSchema;
  access: "read" | "write" | "ask";
  // A tool that omits `providers` is provider-agnostic: always offered.
  // Listing providers offers it only while at least one connected runner
  // runs a listed provider; only genuinely provider-specific tools carry it.
  providers?: Provider[];
  // Per-tool override of the global tool timeout: repo tools run clones,
  // installs and test suites, which dwarf the 15s default.
  timeoutMs?: number;
}

// Where a tool executes is declared, never inferred: an api tool cannot exist
// without its handler, and a runner tool must say how it is addressed.
export type Tool = ToolCommon &
  (
    | {
        on: "api";
        execute(
          input: Record<string, unknown>,
          ctx: ToolExecuteContext,
        ): Promise<ToolExecuteResult>;
      }
    | { on: "runner"; route: CommandRoute }
  );
