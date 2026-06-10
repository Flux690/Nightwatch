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
import {
  publishSessionDelta,
  publishSessionMessage,
  publishToolCall,
} from "../session/stream.js";
import { logger } from "../logger.js";
import type {
  NormalizedAlert,
  SessionMessage,
  SessionMeta,
  SessionTrigger,
} from "@nightwatch/shared";
import type { ProviderMessage, ToolResult } from "../llm/types.js";

const APPEND_TIMEOUT_MS = 10_000;

export interface RunInvestigationInput {
  alert: NormalizedAlert;
  sessionId: string;
  trigger: SessionTrigger;
  // Resume: a prior transcript to seed before continuing.
  seed?: ProviderMessage[];
  // Human-authored opening (chat) or continuation (resume) message.
  userMessage?: string;
}

export async function runInvestigation(
  input: RunInvestigationInput,
): Promise<void> {
  const { alert, sessionId, trigger } = input;
  const incidentId = `${alert.token}-${alert.sourceAlertId}-${Date.now()}`;
  const log = logger.child({
    incidentId,
    sessionId,
    alertType: alert.alertType,
  });
  log.info(
    { target: alert.targetIdentifier, severity: alert.severity, trigger },
    "investigation started",
  );

  const config = await loadConfig();
  const { systemPrompt, firstUserMessage } = await buildInitialContext(alert);
  const provider = createProvider(systemPrompt, config);

  // Persist (durable, on the runner) and broadcast (live, to the console) every
  // new provider message exactly once, in order. The first append upserts the
  // session row; later appends only add messages.
  let persistedCount = 0;
  if (input.seed && input.seed.length > 0) {
    provider.seed(input.seed);
    if (input.userMessage) provider.appendUserMessage(input.userMessage);
    // Seeded turns are already on the runner; only new ones get persisted.
    persistedCount = input.seed.length;
  } else {
    provider.start(input.userMessage ?? firstUserMessage);
  }

  const sessionMeta: SessionMeta = {
    sessionId,
    token: alert.token,
    trigger,
    title:
      trigger === "chat" && input.userMessage
        ? input.userMessage.slice(0, 80)
        : `${alert.alertType} - ${alert.targetIdentifier}`,
    createdAt: new Date().toISOString(),
  };
  const persist = async (): Promise<void> => {
    const snap = provider.snapshot();
    for (let seq = persistedCount; seq < snap.length; seq++) {
      const m = snap[seq];
      if (!m) continue;
      const message: SessionMessage = {
        sessionId,
        seq,
        role: m.role,
        content: m.content,
        providerContent: m.providerContent,
        createdAt: new Date().toISOString(),
      };
      try {
        await sendCommand(
          alert.token,
          "append_session_message",
          { session: sessionMeta, message },
          APPEND_TIMEOUT_MS,
        );
      } catch (err) {
        log.warn({ err, seq }, "failed to persist session message");
      }
      publishSessionMessage(sessionId, message);
    }
    persistedCount = snap.length;
  };

  let toolCallCount = 0;
  let clarificationsUsed = 0;
  let turn = 0;
  let deadline = Date.now() + config.hardTimeoutMs;

  while (toolCallCount < config.maxToolCalls && Date.now() < deadline) {
    turn++;
    const startedAt = Date.now();
    const response = await provider.chat(TOOL_SCHEMAS, (d) =>
      publishSessionDelta(sessionId, d),
    );
    log.info(
      {
        turn,
        ms: Date.now() - startedAt,
        stopReason: response.stopReason,
        toolUses: response.toolUses.map((t) => t.name),
      },
      "LLM responded",
    );
    await persist();

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
          await conclude(alert, incidentId, sessionId, parsed.data);
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
      const gated =
        RUNNER_TOOLS.has(tool.name) && REQUIRES_APPROVAL.has(tool.name);
      publishToolCall({
        sessionId,
        toolUseId: tool.id,
        toolName: tool.name,
        phase: "start",
        input: tool.input,
        awaitingApproval: gated,
        incidentId,
      });

      if (PLATFORM_TOOLS.has(tool.name)) {
        log.debug({ tool: tool.name, kind: "platform" }, "dispatching tool");
        const result = await handlePlatformTool(
          tool,
          incidentId,
          clarificationsUsed,
        );
        if (tool.name === "request_clarification") clarificationsUsed++;
        toolResults.push(result);
        publishToolCall({
          sessionId,
          toolUseId: tool.id,
          toolName: tool.name,
          phase: "result",
          result: result.content,
          isError: result.is_error,
        });
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
            const rejected: ToolResult = {
              tool_use_id: tool.id,
              content: "Rejected by human reviewer. Do not retry this action.",
              is_error: true,
            };
            toolResults.push(rejected);
            publishToolCall({
              sessionId,
              toolUseId: tool.id,
              toolName: tool.name,
              phase: "result",
              result: rejected.content,
              isError: true,
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
            // Stays a tool_result (not a user message): the provider contract
            // requires every tool_use to be answered with a tool_result (D10).
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
          publishToolCall({
            sessionId,
            toolUseId: tool.id,
            toolName: tool.name,
            phase: "result",
            result,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn({ tool: tool.name, err }, "runner tool failed");
          toolResults.push({
            tool_use_id: tool.id,
            content: `Error executing ${tool.name}: ${msg}`,
            is_error: true,
          });
          publishToolCall({
            sessionId,
            toolUseId: tool.id,
            toolName: tool.name,
            phase: "result",
            result: msg,
            isError: true,
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
    await persist();
  }

  await escalate(
    alert,
    incidentId,
    `Exceeded ${config.maxToolCalls} tool calls or ${config.hardTimeoutMs / 60_000}m timeout`,
  );
}
