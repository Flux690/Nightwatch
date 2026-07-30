import { sendCommand, sendFleetCommand } from "../ws/command-transport.js";
import { logger } from "../logger.js";
import type {
  Tool,
  ToolExecuteContext,
  ToolExecuteResult,
} from "./tools/types.js";

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
    const { envelope, anySucceeded } = await sendFleetCommand(
      name,
      input,
      tool.platform,
      ctx.toolTimeoutMs,
    );
    // One runner failing inside a fan-out is that entry's result. Every runner
    // failing is the call failing, so it must not render as a green row.
    return anySucceeded
      ? { content: envelope }
      : { content: envelope, is_error: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ tool: name, err }, "runner tool failed");
    return { content: `Error executing ${name}: ${msg}`, is_error: true };
  }
}
