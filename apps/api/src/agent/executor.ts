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

/* Unreachable may answer next time; a routing mistake will not. A service the
   runner cannot find is neither: the container is not running, which is a
   finding rather than a broken tool. */
function classifyRunnerError(err: unknown): ToolOutcome {
  if (
    err instanceof RunnerUnreachableError ||
    err instanceof NoPlatformRunnerError
  ) {
    return "retryable";
  }
  return isMissingTarget(err) ? "expected_miss" : "system";
}

// The runners' own wording, which crosses the wire as a plain message: both
// answer a target they cannot resolve with "No running <thing> found for".
function isMissingTarget(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /^No running \w+ found for /.test(message);
}

/* What the agent should do about it, which the old one sentence never said. It
   named the tool and the raw message for all 25 runner tools and stopped. */
function runnerFailureMessage(
  name: string,
  msg: string,
  toolOutcome: ToolOutcome,
): string {
  if (toolOutcome === "expected_miss") {
    return `${name} found nothing to read: ${msg}. That is an answer, not a fault - the service is not running there. Confirm it with a list tool before concluding, and say so if it is the finding.`;
  }
  if (toolOutcome === "retryable") {
    return `${name} could not reach the runner it needs: ${msg}. Nothing was read, so this says nothing about the service. Try again, or work from what another tool can tell you.`;
  }
  return `${name} failed: ${msg}. Nothing was read, so draw no conclusion from it. Check the arguments against the tool's description, and if they were right, this is a fault rather than a finding.`;
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
    const toolOutcome = classifyRunnerError(err);
    logger.warn({ tool: name, err, toolOutcome }, "runner tool failed");
    return {
      content: runnerFailureMessage(name, msg, toolOutcome),
      toolOutcome,
    };
  }
}
