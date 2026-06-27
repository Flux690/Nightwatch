import { sendCommand } from "../ws/command-transport.js";
import { logger } from "../logger.js";
import type { ToolExecuteContext, ToolExecuteResult } from "./tools.js";

// Single dispatch + error-formatting primitive used by the loop's read path
// (via tool execute()) and the resolver's approve path. Keeping both in one
// place means error message format and logging are never out of sync.
export async function executeRunnerTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolExecuteContext,
): Promise<ToolExecuteResult> {
  try {
    const result = await sendCommand(
      name,
      input,
      ctx.toolTimeoutMs,
      ctx.runnerId,
    );
    return { content: result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ tool: name, err }, "runner tool failed");
    return { content: `Error executing ${name}: ${msg}`, is_error: true };
  }
}
