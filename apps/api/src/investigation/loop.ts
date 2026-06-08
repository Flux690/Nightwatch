import { sendCommand } from "../ws/router.js";
import { buildInitialContext } from "./context.js";
import {
  TOOL_SCHEMAS,
  PLATFORM_TOOLS,
  RUNNER_TOOLS,
  REQUIRES_APPROVAL,
  CONCLUDE_TOOL_NAME,
} from "./tools.js";
import { createProvider } from "../llm/factory.js";
import { loadConfig } from "../config/store.js";
import { requestApproval } from "./approvals.js";
import { handlePlatformTool } from "./platform.js";
import { conclude, escalate, InvestigationResultSchema } from "./result.js";
import { logger } from "../logger.js";
import type { NormalizedAlert } from "@nightwatch/shared";
import type { ToolResult } from "../llm/types.js";

export async function runInvestigation(alert: NormalizedAlert): Promise<void> {
  const incidentId = `${alert.token}-${alert.sourceAlertId}-${Date.now()}`;
  const log = logger.child({ incidentId, alertType: alert.alertType });
  log.info(
    { target: alert.targetIdentifier, severity: alert.severity },
    "investigation started",
  );

  const config = await loadConfig();
  const { systemPrompt, firstUserMessage } = await buildInitialContext(alert);
  const provider = createProvider(systemPrompt, config);
  provider.start(firstUserMessage);

  let toolCallCount = 0;
  let clarificationsUsed = 0;
  let turn = 0;
  let deadline = Date.now() + config.hardTimeoutMs;

  while (toolCallCount < config.maxToolCalls && Date.now() < deadline) {
    turn++;
    const startedAt = Date.now();
    const response = await provider.chat(TOOL_SCHEMAS);
    log.info(
      {
        turn,
        ms: Date.now() - startedAt,
        stopReason: response.stopReason,
        toolUses: response.toolUses.map((t) => t.name),
      },
      "LLM responded",
    );

    if (response.stopReason === "refusal") {
      await escalate(alert, incidentId, "Model refused to continue");
      return;
    }

    // The model ends the investigation by calling `conclude`. Stopping with no
    // tool call means it failed to do so - escalate rather than silently drop.
    if (response.toolUses.length === 0) {
      await escalate(
        alert,
        incidentId,
        `Model stopped without calling ${CONCLUDE_TOOL_NAME}: ${response.text.slice(0, 200)}`,
      );
      return;
    }

    const toolResults: ToolResult[] = [];

    for (const tool of response.toolUses) {
      if (tool.name === CONCLUDE_TOOL_NAME) {
        const parsed = InvestigationResultSchema.safeParse(tool.input);
        if (parsed.success) {
          await conclude(alert, incidentId, parsed.data);
        } else {
          await escalate(
            alert,
            incidentId,
            `${CONCLUDE_TOOL_NAME} failed schema validation: ${parsed.error.message}`,
          );
        }
        return;
      }

      toolCallCount++;

      if (PLATFORM_TOOLS.has(tool.name)) {
        log.debug({ tool: tool.name, kind: "platform" }, "dispatching tool");
        const result = await handlePlatformTool(
          tool,
          incidentId,
          clarificationsUsed,
        );
        if (tool.name === "request_clarification") clarificationsUsed++;
        toolResults.push(result);
        continue;
      }

      if (RUNNER_TOOLS.has(tool.name)) {
        if (REQUIRES_APPROVAL.has(tool.name)) {
          log.info({ tool: tool.name }, "awaiting human approval");
          // Human think-time must not be charged against the hard deadline.
          const waitedFrom = Date.now();
          const decision = await requestApproval(alert, incidentId, tool);
          deadline += Date.now() - waitedFrom;
          log.info(
            { tool: tool.name, decision: decision.action },
            "approval resolved",
          );

          if (decision.action === "reject") {
            toolResults.push({
              tool_use_id: tool.id,
              content: "Rejected by human reviewer. Do not retry this action.",
              is_error: true,
            });
            if (alert.severity === "critical") {
              log.warn(
                { tool: tool.name },
                "critical write rejected, escalating",
              );
              await escalate(
                alert,
                incidentId,
                `Write action rejected: ${tool.name}`,
              );
              return;
            }
            continue;
          }

          if (decision.action === "add_context") {
            toolResults.push({
              tool_use_id: tool.id,
              content: `Human added context: ${decision.contextMessage ?? "(no message)"}`,
            });
            continue;
          }
          // action === "approve" — fall through to sendCommand
        }

        log.debug({ tool: tool.name, kind: "runner" }, "dispatching tool");
        try {
          const result = await sendCommand(
            alert.token,
            tool.name,
            tool.input,
            config.toolTimeoutMs,
          );
          toolResults.push({
            tool_use_id: tool.id,
            content: JSON.stringify(result),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn({ tool: tool.name, err }, "runner tool failed");
          toolResults.push({
            tool_use_id: tool.id,
            content: `Error executing ${tool.name}: ${msg}`,
            is_error: true,
          });
        }
        continue;
      }

      log.warn({ tool: tool.name }, "LLM requested unknown tool");
      toolResults.push({
        tool_use_id: tool.id,
        content: `Unknown tool "${tool.name}". Platform configuration error - no routing entry. Do not retry.`,
        is_error: true,
      });
    }

    provider.appendToolResults(toolResults);
  }

  await escalate(
    alert,
    incidentId,
    `Exceeded ${config.maxToolCalls} tool calls or ${config.hardTimeoutMs / 60_000}m timeout`,
  );
}
