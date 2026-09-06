import {
  RunnerUnreachableError,
  sendCommand,
  sendFleetCommand,
} from "../fleet/transport.js";
import { NoPlatformRunnerError } from "../fleet/router.js";
import { logger } from "../logger.js";
import type {
  Tool,
  ToolExecuteContext,
  ToolExecuteResult,
} from "./tools/types.js";

// Chooses the wording below and whether the call reads as a failure. Held here
// rather than on the result: how a call travelled is not what it found.
type RunnerFailure = "retryable" | "expected_miss" | "system";

/* Unreachable may answer next time; a routing mistake will not. A service the
   runner cannot find is neither, but a finding: the container is not running. */
function classifyRunnerError(err: unknown): RunnerFailure {
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

// What the agent should do about it: a tool name and a raw message say what
// broke and leave the next move unstated, across all 25 runner tools.
function runnerFailureMessage(
  name: string,
  msg: string,
  failure: RunnerFailure,
): string {
  if (failure === "expected_miss") {
    return `${name} found nothing to read: ${msg}. That is an answer, not a fault - the service is not running there. Confirm it with a list tool before concluding, and say so if it is the finding.`;
  }
  if (failure === "retryable") {
    return `${name} could not reach the server it needs: ${msg}. Nothing was read, so this says nothing about the service. Try again, or work from what another tool can tell you.`;
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
    // A fan-out has three answers, not two, and only none-answered is a
    // failure: the envelope names which server fell short either way.
    if (failed === 0 || succeeded > 0) return { content: envelope };
    return { content: envelope, isError: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const failure = classifyRunnerError(err);
    logger.warn({ tool: name, err, failure }, "runner tool failed");
    // Every branch read nothing, a missing target included: that the absence
    // is itself informative is what the message says, not what the flag says.
    return { content: runnerFailureMessage(name, msg, failure), isError: true };
  }
}
