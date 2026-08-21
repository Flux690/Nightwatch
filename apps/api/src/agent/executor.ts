import {
  RunnerUnreachableError,
  sendCommand,
  sendFleetCommand,
} from "../ws/command-transport.js";
import { NoPlatformRunnerError } from "../ws/router.js";
import { logger } from "../logger.js";
import type { ToolOutcome } from "@nightwarden/shared";
import type {
  Tool,
  ToolExecuteContext,
  ToolExecuteResult,
} from "./tools/types.js";

// A runner that never answered may answer next time; anything the runner itself
// reported back, or a routing mistake, will not change on a retry.
function classifyRunnerError(err: unknown): ToolOutcome {
  return err instanceof RunnerUnreachableError ||
    err instanceof NoPlatformRunnerError
    ? "retryable"
    : "system";
}

// Single dispatch + error-formatting primitive shared by the loop's read path and the
// resolver's approve path, so error format and logging never drift apart.
export async function executeRunnerTool(
  tool: Extract<Tool, { on: "runner" }>,
  input: Record<string, unknown>,
  ctx: ToolExecuteContext,
): Promise<ToolExecuteResult> {
  const name = tool.schema.name;
  try {
    if (tool.routeBy === "service") {
      return { content: await sendCommand(name, input, ctx.toolTimeoutMs) };
    }
    const { envelope, succeeded, failed } = await sendFleetCommand(
      name,
      input,
      tool.platform,
      ctx.toolTimeoutMs,
    );
    // A fan-out has three answers, not two: every runner answered, some did, or
    // none did. Each runner's own reason rides in the envelope either way.
    if (failed === 0) return { content: envelope };
    return succeeded > 0
      ? { content: envelope, toolOutcome: "partial" }
      : { content: envelope, toolOutcome: "system" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ tool: name, err }, "runner tool failed");
    return {
      content: `Error executing ${name}: ${msg}`,
      toolOutcome: classifyRunnerError(err),
    };
  }
}
