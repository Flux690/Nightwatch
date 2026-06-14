import { randomUUID } from "node:crypto";
import { sendCommand } from "../ws/router.js";
import { buildInitialContext, buildChatContext } from "./context.js";
import {
  TOOL_SCHEMAS,
  PLATFORM_TOOLS,
  RUNNER_TOOLS,
  REQUIRES_APPROVAL,
} from "./tools.js";
import { createProvider } from "../llm/factory.js";
import { loadConfig, loadApiKey } from "../config/store.js";
import { handlePlatformTool } from "./platform.js";
import { escalate, type IncidentContext } from "./result.js";
import {
  createSession,
  appendSessionMessages,
  appendMessagesAndInterrupt,
  getSession,
} from "../db/sessions.js";
import {
  publishTextMessageContent,
  publishRunFinished,
  publishToolCallStart,
  publishInterrupt,
  publishToolCallEnd,
} from "../session/stream.js";
import { dispatcher } from "../dispatch/dispatcher.js";
import { logger } from "../logger.js";
import type {
  NormalizedAlert,
  SessionMessage,
  SessionMeta,
  SessionTrigger,
} from "@nightwatch/shared";
import type { ProviderMessage, ToolResult, ToolUse } from "../llm/types.js";
import type { PendingInterrupt } from "../db/interrupts.js";

export interface RunInvestigationInput {
  sessionId: string;
  token: string;
  trigger: SessionTrigger;
  alert?: NormalizedAlert;
  // Additional alerts that arrived within the 90s batch window alongside the
  // primary alert. All are included in the opening message for shared root-cause
  // analysis. Only populated on batch-triggered sessions.
  additionalAlerts?: NormalizedAlert[];
  seed?: ProviderMessage[];
  userMessage?: string;
  // Present on resume: the full tool_results for the suspended turn
  // (completedResults from interrupt row + the newly resolved gated result).
  resumeToolResults?: ToolResult[];
}

export async function runInvestigation(
  input: RunInvestigationInput,
): Promise<void> {
  const { sessionId, token, trigger } = input;

  const alert = input.alert ?? getSession(sessionId)?.originatingAlert ?? null;

  const ctx: IncidentContext & { severity: NormalizedAlert["severity"] } = {
    token,
    containerName: alert?.targetIdentifier ?? "chat",
    alertType: alert?.alertType ?? "chat",
    firedAt: alert?.firedAt ?? new Date().toISOString(),
    severity: alert?.severity ?? "info",
  };

  const incidentId = randomUUID();
  const log = logger.child({
    incidentId,
    sessionId,
    alertType: ctx.alertType,
  });
  log.info(
    { target: ctx.containerName, severity: ctx.severity, trigger },
    "investigation started",
  );

  const config = loadConfig();
  const apiKey = loadApiKey();

  const allAlerts = [
    ...(input.alert ? [input.alert] : []),
    ...(input.additionalAlerts ?? []),
  ];
  const { systemPrompt, firstUserMessage } =
    allAlerts.length > 0 ? buildInitialContext(allAlerts) : buildChatContext();
  const provider = createProvider(systemPrompt, config, apiKey);

  let persistedCount = 0;

  if (input.resumeToolResults && input.resumeToolResults.length > 0) {
    // Resume from a durable interrupt: seed the prior transcript, then append
    // the resolved tool_results turn so the next chat() sees a complete context.
    if (input.seed) {
      provider.seed(input.seed);
      persistedCount = input.seed.length;
    }
    provider.appendToolResults(input.resumeToolResults);
    // Persist the tool_results turn (with correct providerContent from the provider).
    const snap = provider.snapshot();
    const newMessages: SessionMessage[] = [];
    for (let seq = persistedCount; seq < snap.length; seq++) {
      const m = snap[seq];
      if (!m) continue;
      newMessages.push({
        sessionId,
        seq,
        role: m.role,
        content: m.content,
        providerContent: m.providerContent,
        createdAt: new Date().toISOString(),
      });
    }
    appendSessionMessages(newMessages);
    for (const message of newMessages) publishRunFinished(sessionId, message);
    persistedCount = snap.length;
  } else if (input.seed && input.seed.length > 0) {
    provider.seed(input.seed);
    if (input.userMessage) provider.appendUserMessage(input.userMessage);
    persistedCount = input.seed.length;
  } else {
    provider.start(input.userMessage ?? firstUserMessage);
  }

  const sessionMeta: SessionMeta = {
    sessionId,
    token,
    trigger,
    title:
      trigger === "chat" && input.userMessage
        ? input.userMessage.slice(0, 80)
        : `${ctx.alertType} - ${ctx.containerName}`,
    createdAt: new Date().toISOString(),
  };
  createSession(sessionMeta, alert);

  const persist = (): void => {
    const snap = provider.snapshot();
    const newMessages: SessionMessage[] = [];
    for (let seq = persistedCount; seq < snap.length; seq++) {
      const m = snap[seq];
      if (!m) continue;
      newMessages.push({
        sessionId,
        seq,
        role: m.role,
        content: m.content,
        providerContent: m.providerContent,
        createdAt: new Date().toISOString(),
      });
    }
    appendSessionMessages(newMessages);
    for (const message of newMessages) publishRunFinished(sessionId, message);
    persistedCount = snap.length;
  };

  let toolCallCount = 0;
  let turn = 0;
  const deadline = Date.now() + config.hardTimeoutMs;

  while (toolCallCount < config.maxToolCalls && Date.now() < deadline) {
    turn++;
    const startedAt = Date.now();
    const response = await provider.chat(TOOL_SCHEMAS, (d) =>
      publishTextMessageContent(sessionId, d),
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
    persist();

    if (response.stopReason === "refusal") {
      escalate(ctx, incidentId, sessionId, "Model refused to continue");
      return;
    }

    // No tool calls means the model is done: its free-form text is the answer.
    // persist() above already published it via RUN_FINISHED, so the run simply
    // ends here - a prose finish is success, not an escalation.
    if (response.toolUses.length === 0) {
      log.info({ turn }, "investigation finished with free-form response");
      return;
    }

    // Two-pass: execute non-gated tools first, accumulate their results, then
    // suspend on the first gated tool. Non-gated results become completedResults
    // on the interrupt row so the resume can assemble the single tool_results
    // message the provider contract requires (D9, D10).
    const toolResults: ToolResult[] = [];
    let gatedTool: ToolUse | null = null;

    for (const tool of response.toolUses) {
      toolCallCount++;

      const isClarification = tool.name === "request_clarification";
      const isApproval =
        RUNNER_TOOLS.has(tool.name) && REQUIRES_APPROVAL.has(tool.name);

      if (isClarification || isApproval) {
        if (gatedTool === null) {
          // Capture the first gated tool; execution deferred to the resume run.
          gatedTool = tool;
        } else {
          // Only one gate per turn; reject subsequent gated tools so every
          // tool_use in this assistant message still gets a tool_result (D10).
          toolResults.push({
            tool_use_id: tool.id,
            content:
              "Another gated action is pending. Retry after it resolves.",
            is_error: true,
          });
        }
        continue;
      }

      if (PLATFORM_TOOLS.has(tool.name)) {
        publishToolCallStart({
          sessionId,
          toolUseId: tool.id,
          toolName: tool.name,
          input: tool.input,
        });
        const result = await handlePlatformTool(tool, token, incidentId);
        toolResults.push(result);
        publishToolCallEnd({
          sessionId,
          toolUseId: tool.id,
          result: result.content,
          isError: result.is_error,
        });
        continue;
      }

      if (RUNNER_TOOLS.has(tool.name)) {
        publishToolCallStart({
          sessionId,
          toolUseId: tool.id,
          toolName: tool.name,
          input: tool.input,
        });
        try {
          const result = await sendCommand(
            token,
            tool.name,
            tool.input,
            config.toolTimeoutMs,
          );
          toolResults.push({
            tool_use_id: tool.id,
            content: JSON.stringify(result),
          });
          publishToolCallEnd({ sessionId, toolUseId: tool.id, result });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn({ tool: tool.name, err }, "runner tool failed");
          toolResults.push({
            tool_use_id: tool.id,
            content: `Error executing ${tool.name}: ${msg}`,
            is_error: true,
          });
          publishToolCallEnd({
            sessionId,
            toolUseId: tool.id,
            result: msg,
            isError: true,
          });
        }
        continue;
      }

      log.warn({ tool: tool.name }, "LLM requested unknown tool");
      toolResults.push({
        tool_use_id: tool.id,
        content: `Unknown tool "${tool.name}". Platform configuration error. Do not retry.`,
        is_error: true,
      });
    }

    if (gatedTool !== null) {
      // Durably suspend: persist the assistant turn + interrupt row in ONE
      // transaction (D3). The run then exits and frees its dispatcher slot.
      // Suspended sessions never receive injections: the inbox is NOT drained
      // here; any inbox alerts become new sessions via the dispatcher's finally.
      const isClarificationGate = gatedTool.name === "request_clarification";
      const interrupt: PendingInterrupt = {
        id: incidentId,
        sessionId,
        toolUseId: gatedTool.id,
        kind: isClarificationGate ? "clarification" : "approval",
        toolName: gatedTool.name,
        toolInput: gatedTool.input,
        completedResults: toolResults,
        createdAt: new Date().toISOString(),
      };
      const snap = provider.snapshot();
      const newMessages: SessionMessage[] = [];
      for (let seq = persistedCount; seq < snap.length; seq++) {
        const m = snap[seq];
        if (!m) continue;
        newMessages.push({
          sessionId,
          seq,
          role: m.role,
          content: m.content,
          providerContent: m.providerContent,
          createdAt: new Date().toISOString(),
        });
      }
      appendMessagesAndInterrupt(newMessages, interrupt);
      for (const message of newMessages) publishRunFinished(sessionId, message);
      persistedCount = snap.length;
      // Publish INTERRUPT after the row is durably in the DB.
      const clarInput = isClarificationGate
        ? (gatedTool.input as {
            question: string;
            options: Array<{ label: string; description: string }>;
            multiSelect?: boolean;
          })
        : null;
      publishInterrupt({
        sessionId,
        toolUseId: gatedTool.id,
        toolName: gatedTool.name,
        input: gatedTool.input,
        incidentId,
        kind: isClarificationGate ? "clarification" : "approval",
        ...(clarInput !== null && {
          question: clarInput.question,
          options: clarInput.options,
          multiSelect: clarInput.multiSelect,
        }),
      });
      log.info(
        { tool: gatedTool.name, kind: interrupt.kind, incidentId },
        "run suspended: pending interrupt",
      );
      return;
    }

    // Drain mid-run injected alerts at the tool boundary. They ride in the same
    // user message as the tool results so the provider never sees two consecutive
    // user turns (D10). The model is asked to judge each as a downstream effect
    // or an independent incident.
    const injected = dispatcher.drainInbox(sessionId);
    const injectionText =
      injected.length > 0 ? formatInjectedAlerts(injected) : undefined;

    provider.appendToolResults(toolResults, injectionText);
    persist();
  }

  escalate(
    ctx,
    incidentId,
    sessionId,
    `Exceeded ${config.maxToolCalls} tool calls or ${config.hardTimeoutMs / 60_000}m timeout`,
  );
}

function formatInjectedAlerts(alerts: NormalizedAlert[]): string {
  const header =
    alerts.length === 1
      ? "\n\nINJECTED ALERT - decide: downstream effect of current incident or independent incident?"
      : `\n\nINJECTED ALERTS (${alerts.length}) - for each, decide: downstream effect of current incident or independent incident?`;
  return (
    header +
    "\n" +
    alerts
      .map(
        (a) =>
          `- [${a.alertType}] ${a.targetIdentifier} (${a.severity}) fired at ${a.firedAt} [id: ${a.sourceAlertId}]`,
      )
      .join("\n")
  );
}
