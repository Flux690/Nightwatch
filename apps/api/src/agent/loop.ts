import { randomUUID } from "node:crypto";
import { buildInitialContext, buildChatContext } from "./context.js";
import { effectiveToolset } from "./tools.js";
import type { ToolExecuteContext } from "./tools.js";
import { currentFleetProviders, currentRemediationEnabled } from "./policy.js";
import { processToolUses } from "./turn.js";
import { createProvider } from "../llm/factory.js";
import { loadConfig, loadApiKey } from "../config/store.js";
import {
  createSession,
  appendSessionMessages,
  appendMessagesAndInterrupt,
  getSession,
} from "../db/sessions.js";
import {
  publishTextMessageContent,
  publishRunFinished,
  publishInterrupt,
  publishRunStopped,
} from "../session/stream.js";
import { dispatcher } from "../dispatcher.js";
import { getFleetView, getRunnerManifestForAlert } from "../ws/router.js";
import { logger } from "../logger.js";
import type {
  NormalizedAlert,
  SessionMessage,
  SessionMeta,
} from "@nightwatch/shared";
import type {
  ChatResponse,
  LLMProvider,
  ProviderMessage,
  ToolResult,
} from "../llm/types.js";
import type { PendingHumanInput } from "../db/interrupts.js";

// sole writer of session_messages; diffs provider snapshot against persisted, writes the diff atomically
function persistNewTurns(
  provider: LLMProvider,
  sessionId: string,
  fromSeq: number,
  interrupt?: PendingHumanInput,
): number {
  const snap = provider.snapshot();
  const newMessages: SessionMessage[] = [];
  for (let seq = fromSeq; seq < snap.length; seq++) {
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
  if (interrupt) {
    appendMessagesAndInterrupt(newMessages, interrupt);
  } else {
    appendSessionMessages(newMessages);
  }
  for (const message of newMessages) publishRunFinished(sessionId, message);
  return snap.length;
}

// null alert = chat session; title from user message. alert session = alert type + target.
function buildSessionMeta(
  sessionId: string,
  alert: NormalizedAlert | null,
  userMessage: string | undefined,
): SessionMeta {
  return {
    sessionId,
    title:
      alert == null && userMessage
        ? userMessage.slice(0, 80)
        : `${alert?.alertType ?? "chat"} - ${alert?.targetIdentifier ?? "chat"}`,
    createdAt: new Date().toISOString(),
  };
}

export interface RunInvestigationInput {
  sessionId: string;
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
  // Aborts the LLM request in flight when the dispatcher stops this run.
  signal?: AbortSignal;
  // When true: seed prior transcript and run exactly one wrap-up turn (no tools),
  // then finish. Used when the operator declines a continue-request interrupt.
  wrapUp?: boolean;
}

export async function runInvestigation(
  input: RunInvestigationInput,
): Promise<void> {
  const { sessionId, signal } = input;

  const alert = input.alert ?? getSession(sessionId)?.originatingAlert ?? null;

  const log = logger.child({
    sessionId,
    alertType: alert?.alertType ?? "chat",
  });

  const config = loadConfig();
  const apiKey = loadApiKey();

  // Operator declined a continue-request: replay the transcript and run one free-form
  // wrap-up turn (no tools), then finish. The seed already carries the investigation, so
  // skip the alert/fleet context build below.
  if (input.wrapUp) {
    const remediationEnabled = currentRemediationEnabled(
      alert?.runnerId ?? undefined,
    );
    const { systemPrompt } = buildChatContext(remediationEnabled);
    const provider = createProvider(systemPrompt, config, apiKey);
    createSession(buildSessionMeta(sessionId, alert, input.userMessage), alert);

    let persistedCount = 0;
    if (input.seed && input.seed.length > 0) {
      provider.seed(input.seed);
      persistedCount = input.seed.length;
    }
    log.info("time budget ended: operator chose to end, running wrap-up turn");
    try {
      await provider.chat(
        [],
        (d) => publishTextMessageContent(sessionId, d),
        signal,
      );
    } catch (err) {
      if (!signal?.aborted) throw err;
    }
    persistNewTurns(provider, sessionId, persistedCount);
    if (signal?.aborted) {
      publishRunStopped(sessionId);
      log.info("run stopped by user during end wrap-up");
      return;
    }
    log.info("investigation ended after operator declined to continue");
    return;
  }

  log.info(
    {
      target: alert?.targetIdentifier ?? "chat",
      severity: alert?.severity ?? "info",
      isChat: alert == null,
    },
    "investigation started",
  );

  const allAlerts = [
    ...(input.alert ? [input.alert] : []),
    ...(input.additionalAlerts ?? []),
  ];
  const serviceSnapshot =
    alert != null
      ? getRunnerManifestForAlert(alert.runnerId)?.capabilities.services
      : undefined;
  const remediationEnabled = currentRemediationEnabled(
    alert?.runnerId ?? undefined,
  );
  const fleetView = getFleetView();
  const { systemPrompt, firstUserMessage } =
    allAlerts.length > 0
      ? buildInitialContext(
          allAlerts,
          serviceSnapshot,
          remediationEnabled,
          fleetView,
        )
      : buildChatContext(remediationEnabled);
  const provider = createProvider(systemPrompt, config, apiKey);

  createSession(buildSessionMeta(sessionId, alert, input.userMessage), alert);

  let persistedCount = 0;

  if (input.resumeToolResults && input.resumeToolResults.length > 0) {
    // Resume from a durable interrupt: seed the prior transcript, then append
    // the resolved tool_results turn so the next chat() sees a complete context.
    if (input.seed) {
      provider.seed(input.seed);
      persistedCount = input.seed.length;
    }
    provider.appendToolResults(input.resumeToolResults);
    persistedCount = persistNewTurns(provider, sessionId, persistedCount);
  } else if (input.seed && input.seed.length > 0) {
    provider.seed(input.seed);
    persistedCount = input.seed.length;
    // Persist the new user turn immediately so the console shows it the moment
    // it's sent, instead of waiting for the assistant's reply to flush both at once.
    if (input.userMessage) {
      provider.appendUserMessage(input.userMessage);
      persistedCount = persistNewTurns(provider, sessionId, persistedCount);
    }
  } else {
    provider.start(input.userMessage ?? firstUserMessage);
    persistedCount = persistNewTurns(provider, sessionId, persistedCount);
  }

  const persist = (): void => {
    persistedCount = persistNewTurns(provider, sessionId, persistedCount);
  };

  let turn = 0;
  // Time is the only budget ceiling. The deadline is checked at each turn
  // boundary; it does not tick during approval or clarification waits because
  // the run exits while suspended and recomputes a fresh deadline on resume.
  const deadline = Date.now() + config.hardTimeoutMs;
  const fleetProviders = currentFleetProviders();

  // Resolve the effective tool set ONCE per run from remediation mode + fleet providers.
  // It backs both the offered schemas and the names the turn executor resolves, so prompt
  // and menu can't disagree; a resume recomputes it fresh.
  const toolset = effectiveToolset(fleetProviders, remediationEnabled);
  const toolSchemas = toolset.map((t) => t.schema);

  while (Date.now() < deadline) {
    turn++;
    const startedAt = Date.now();
    let response: ChatResponse;
    try {
      response = await provider.chat(
        toolSchemas,
        (d) => publishTextMessageContent(sessionId, d),
        signal,
      );
    } catch (err) {
      if (signal?.aborted) {
        log.info({ turn }, "run stopped by user");
        persist();
        publishRunStopped(sessionId);
        return;
      }
      throw err;
    }
    if (signal?.aborted) {
      log.info({ turn }, "run stopped by user");
      persist();
      publishRunStopped(sessionId);
      return;
    }
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
      log.warn({ turn }, "model refused to continue");
      return;
    }

    if (response.toolUses.length === 0) {
      log.info({ turn }, "investigation finished with free-form response");
      return;
    }

    const execCtx: ToolExecuteContext = {
      runnerId: alert?.runnerId ?? undefined,
      toolTimeoutMs: config.toolTimeoutMs,
    };

    const { toolResults, gated } = await processToolUses({
      toolUses: response.toolUses,
      toolset,
      sessionId,
      execCtx,
      config,
      log,
    });

    if (gated !== null) {
      // Durably suspend: persist the assistant turn + interrupt row in one transaction; the run
      // then exits and frees its slot. Suspended sessions take no injections - the inbox isn't
      // drained here.
      const isAskGate = gated.entry.access === "ask";
      const interrupt: PendingHumanInput = {
        sessionId,
        toolUseId: gated.tool.id,
        kind: isAskGate ? "clarification" : "approval",
        toolName: gated.tool.name,
        toolInput: gated.tool.input,
        completedResults: toolResults,
        claimedAt: null,
        createdAt: new Date().toISOString(),
      };
      persistedCount = persistNewTurns(
        provider,
        sessionId,
        persistedCount,
        interrupt,
      );
      // Publish HUMAN_INPUT_REQUIRED after the row is durably in the DB.
      const clarInput = isAskGate
        ? (gated.tool.input as {
            question: string;
            options: Array<{ label: string; description: string }>;
            multiSelect?: boolean;
          })
        : null;
      publishInterrupt({
        sessionId,
        toolUseId: gated.tool.id,
        toolName: gated.tool.name,
        input: gated.tool.input,
        kind: isAskGate ? "clarification" : "approval",
        ...(clarInput !== null && {
          question: clarInput.question,
          options: clarInput.options,
          multiSelect: clarInput.multiSelect,
        }),
      });
      log.info(
        { tool: gated.tool.name, kind: interrupt.kind },
        "run suspended: pending human input",
      );
      return;
    }

    // Drain mid-run injected alerts at the tool boundary, riding the same user message as the
    // tool results so the provider never sees two consecutive user turns (D10). The model
    // judges each as downstream effect or independent incident.
    const injected = dispatcher.drainInbox(sessionId);
    const injectionText =
      injected.length > 0 ? formatInjectedAlerts(injected) : undefined;

    provider.appendToolResults(toolResults, injectionText);
    persist();
  }

  // Time budget reached: suspend with a continue-request so the operator can resume (fresh
  // deadline) or end. A continue request has no underlying tool call, so its synthetic
  // toolUseId only keys the interrupt row - the resolver branches on kind, not the transcript.
  const continueId = randomUUID();
  const continueInterrupt: PendingHumanInput = {
    sessionId,
    toolUseId: continueId,
    kind: "continue",
    toolName: "",
    toolInput: {},
    completedResults: [],
    claimedAt: null,
    createdAt: new Date().toISOString(),
  };
  persistedCount = persistNewTurns(
    provider,
    sessionId,
    persistedCount,
    continueInterrupt,
  );
  publishInterrupt({
    sessionId,
    toolUseId: continueId,
    toolName: "",
    input: {},
    kind: "continue",
  });
  log.info({ turn }, "time budget reached: suspended with continue request");
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
          `- [${a.alertType}] ${JSON.stringify(a.targetIdentifier)} (${a.severity}) fired at ${a.firedAt} [id: ${a.sourceAlertId}]`,
      )
      .join("\n")
  );
}
