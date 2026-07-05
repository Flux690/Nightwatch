import {
  countExecutedRemediations,
  serviceIdentityKeyFromInput,
} from "../db/remediation-actions.js";
import type { AgentConfig } from "@nightwatch/shared";
import type { ToolResult, ToolUse } from "../llm/types.js";

// Circuit breaker: refuse a write before it suspends when too many writes to the same
// (identity, action) already landed in the window, so a crash-loop fix can't become a
// restart storm. Returns a corrective tool_result when tripped, null otherwise.
export function circuitBreakerRejection(
  tool: ToolUse,
  config: AgentConfig,
): ToolResult | null {
  const key = serviceIdentityKeyFromInput(tool.input);
  if (key === null) return null;
  const since = new Date(
    Date.now() - config.remediationBreakerWindowMs,
  ).toISOString();
  const count = countExecutedRemediations({
    serviceIdentityKey: key,
    toolName: tool.name,
    since,
  });
  if (count < config.remediationBreakerLimit) return null;
  const windowMinutes = Math.round(config.remediationBreakerWindowMs / 60_000);
  return {
    tool_use_id: tool.id,
    content: `Circuit breaker: "${tool.name}" has already executed ${count} times on this service in the last ${windowMinutes} minutes (limit ${config.remediationBreakerLimit}). Repeating it is not resolving the problem - do not retry this action. Investigate the root cause or escalate to the operator.`,
    is_error: true,
  };
}
