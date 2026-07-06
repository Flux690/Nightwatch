import type { ToolSchema } from "../../llm/types.js";
import type { CommandRoute } from "../../ws/router.js";

export type Provider = "docker" | "kubernetes";

export interface ToolExecuteResult {
  content: unknown;
  is_error?: boolean;
}

export interface ToolExecuteContext {
  runnerId?: string;
  toolTimeoutMs: number;
}

interface ToolCommon {
  schema: ToolSchema;
  access: "read" | "write" | "ask";
  // A tool that omits `providers` is provider-agnostic: always offered.
  // Listing providers offers it only while at least one connected runner
  // runs a listed provider; only genuinely provider-specific tools carry it.
  providers?: Provider[];
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
