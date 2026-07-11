import { sendCommand } from "../ws/command-transport.js";
import { logger } from "../logger.js";
import type { CommandRoute } from "../ws/router.js";
import type { ToolExecuteContext, ToolExecuteResult } from "./tools/types.js";

// Single dispatch + error-formatting primitive shared by the loop's read path and the
// resolver's approve path, so error format and logging never drift apart.
export async function executeRunnerTool(
  name: string,
  route: CommandRoute,
  input: Record<string, unknown>,
  ctx: ToolExecuteContext,
): Promise<ToolExecuteResult> {
  try {
    const result = await sendCommand(name, input, route, ctx.toolTimeoutMs);
    return { content: result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ tool: name, err }, "runner tool failed");
    return { content: `Error executing ${name}: ${msg}`, is_error: true };
  }
}
