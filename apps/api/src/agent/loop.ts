import { randomUUID } from "node:crypto";
import { buildInitialContext, buildChatContext } from "./context.js";
import type { PromptOptions } from "./prompts/system.js";
import { GATE_NUDGE } from "./prompts/report.js";
import { finalizeInconclusive } from "./report.js";
import { effectiveToolset } from "./tools/toolset.js";
import { REPO_TOOL_NAMES } from "./tools/repo.js";
import type { ToolExecuteContext } from "./tools/types.js";
import {
  currentFleetCapabilities,
  currentRemediationEnabled,
} from "./policy.js";
import { processToolUses } from "./turn.js";
import { retrySummary, withLLMRetries } from "../llm/failures.js";
import { createProvider } from "../llm/factory.js";
import {
  checkLLMReadiness,
  notConfiguredMessage,
} from "../config/readiness.js";
import { loadConfig } from "../config/store.js";
import {
  getGitHubIntegration,
  getPrometheusIntegration,
  getLokiIntegration,
} from "../db/integrations.js";
import {
  createSession,
  promoteSessionToInvestigate,
  appendSessionMessages,
  appendMessagesAndInterrupt,
  getNextSeq,
  getSession,
} from "../db/sessions.js";
import { hasReport, reportComplete } from "../db/reports.js";
import {
  publishTextMessageContent,
  publishMessage,
  publishInterrupt,
  publishRunRetrying,
  publishTranscriptItem,
} from "../session/stream.js";
import { toolCallCard } from "../session/transcript.js";
import {
  generateSessionTitle,
  buildAlertTitleSource,
} from "../session/title.js";
import { dispatcher } from "../dispatcher.js";
import { displayIdentity } from "../alerts/resolve-target.js";
import { getFleetView } from "../ws/fleet.js";
import { logger } from "../logger.js";
import type {
  NormalizedAlert,
  RunMode,
  SessionMessage,
  SessionMeta,
} from "@nightwarden/shared";
import type {
  ChatResponse,
  LLMProvider,
  ProviderMessage,
  ToolResult,
  ToolSchema,
} from "../llm/types.js";
import type { PendingHumanInput } from "../db/interrupts.js";

// Writes the provider-snapshot diff atomically; seq = seqOffset + snapshot
// index so rows the seed skipped (error rows, dead exchanges) never collide.
function persistNewTurns(
  provider: LLMProvider,
  sessionId: string,
  fromCount: number,
  seqOffset: number,
  interrupt?: PendingHumanInput,
): number {
  const snap = provider.snapshot();
  const newMessages: SessionMessage[] = [];
  for (let i = fromCount; i < snap.length; i++) {
    const m = snap[i];
    if (!m) continue;
    newMessages.push({
      sessionId,
      seq: seqOffset + i,
      role: m.role,
      content: m.content,
      parts: m.parts,
      ...(m.native && { native: m.native }),
      createdAt: new Date().toISOString(),
    });
  }
  if (interrupt) {
    appendMessagesAndInterrupt(newMessages, interrupt);
  } else {
    appendSessionMessages(newMessages);
  }
  for (const message of newMessages) publishMessage(sessionId, message);
  return snap.length;
}

// null alert = chat session; title from user message. alert session = alert type + target.
function buildSessionMeta(
  sessionId: string,
  alert: NormalizedAlert | null,
  userMessage: string | undefined,
): SessionMeta {
  const target = alert ? displayIdentity(alert) : "chat";
  return {
    sessionId,
    title:
      alert == null && userMessage
        ? userMessage.slice(0, 80)
        : `${alert?.alertType ?? "chat"} - ${target}`,
    createdAt: new Date().toISOString(),
  };
}

// How a run ended, so the dispatcher (the single lifecycle owner) can emit the
// one matching terminal event. A thrown error is the 4th state, "failed",
// handled by the dispatcher's catch - never returned here.
export type RunOutcome = "completed" | "suspended" | "stopped";

// Finish-gate pushback cap: after this many nudges the run finalizes as
// inconclusive rather than looping; the time budget bounds it as well.
const MAX_NUDGES = 3;

export interface RunInvestigationInput {
  sessionId: string;
  alert?: NormalizedAlert;
  // Alerts that arrived within the 90s batch window alongside the primary one;
  // included in the opening message for shared root-cause analysis (batch-triggered sessions only).
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
  // "investigate" adds the report tool and the finish gate; "ask" is a plain
  // chat. Omitted: derived from the session (alert or existing report -> investigate).
  mode?: RunMode;
}

export async function runInvestigation(
  input: RunInvestigationInput,
): Promise<RunOutcome> {
  const { sessionId, signal } = input;

  const alert = input.alert ?? getSession(sessionId)?.originatingAlert ?? null;

  // Mode is a one-way ratchet, recorded on the session. An alert always
  // investigates; a chat keeps whatever it was last started as.
  const mode: RunMode =
    input.mode ??
    (alert !== null
      ? "investigate"
      : (getSession(sessionId)?.mode ??
        (hasReport(sessionId) ? "investigate" : "ask")));

  const log = logger.child({
    sessionId,
    alertType: alert?.alertType ?? "chat",
    mode,
  });

  if (mode === "investigate") promoteSessionToInvestigate(sessionId);

  // Backstop, not the primary gate: the routes that start a run refuse first.
  // Reaching here unconfigured means a caller bypassed them, so fail loudly.
  const readiness = checkLLMReadiness();
  if (!readiness.ready) {
    throw new Error(notConfiguredMessage(readiness.missing));
  }
  // llm is the active provider's block flattened for the SDK; config carries the
  // loop and sandbox budgets, which are provider-independent.
  const { config: llm, apiKey } = readiness;
  const config = loadConfig();

  // Transient provider errors are waited out instead of killing the run; each
  // wait is streamed to the console as live status.
  const chatWithRetries = (
    provider: LLMProvider,
    toolSchemas: ToolSchema[],
  ): Promise<ChatResponse> =>
    withLLMRetries(
      () =>
        provider.chat(
          toolSchemas,
          (d) => publishTextMessageContent(sessionId, d),
          signal,
        ),
      {
        signal,
        onRetry: (notice) => {
          log.warn(
            { attempt: notice.attempt, delayMs: notice.delayMs },
            "transient LLM error, retrying",
          );
          publishRunRetrying({
            sessionId,
            attempt: notice.attempt + 1,
            maxAttempts: notice.maxAttempts,
            delaySeconds: Math.round(notice.delayMs / 1000),
            summary: retrySummary(notice),
          });
        },
      },
    );

  // Operator declined a continue-request: replay the transcript and run one free-form
  // wrap-up turn (no tools). Seed already carries the investigation, so skip the alert/fleet context build below.
  if (input.wrapUp) {
    const remediationEnabled = currentRemediationEnabled();
    const { systemPrompt } = buildChatContext(
      remediationEnabled,
      undefined,
      undefined,
      mode,
    );
    const provider = createProvider(systemPrompt, llm, apiKey);
    createSession(
      buildSessionMeta(sessionId, alert, input.userMessage),
      alert,
      mode,
    );

    let persistedCount = 0;
    const seqOffset = getNextSeq(sessionId) - (input.seed?.length ?? 0);
    if (input.seed && input.seed.length > 0) {
      provider.seed(input.seed);
      persistedCount = input.seed.length;
    }
    log.info("time budget ended: operator chose to end, running wrap-up turn");
    try {
      await chatWithRetries(provider, []);
    } catch (err) {
      if (!signal?.aborted) throw err;
    }
    persistNewTurns(provider, sessionId, persistedCount, seqOffset);
    if (signal?.aborted) {
      log.info("run stopped by user during end wrap-up");
      return "stopped";
    }
    // The operator is ending the run, so no nudge loop - just guarantee a
    // complete report exists before the terminal event.
    if (mode === "investigate" && !reportComplete(sessionId)) {
      finalizeInconclusive(sessionId, llm.model);
    }
    log.info("investigation ended after operator declined to continue");
    return "completed";
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
  const remediationEnabled = currentRemediationEnabled();
  const fleetView = getFleetView();
  const integration = getGitHubIntegration();
  const promptOptions: PromptOptions = {
    budgetMinutes: Math.max(1, Math.round(config.hardTimeoutMs / 60_000)),
    codeBudgetMinutes: Math.max(
      1,
      Math.round(config.codeSessionBudgetMs / 60_000),
    ),
    repo:
      integration === null
        ? null
        : `${integration.repoOwner}/${integration.repoName}`,
  };
  const { systemPrompt, firstUserMessage } =
    allAlerts.length > 0
      ? buildInitialContext(
          allAlerts,
          remediationEnabled,
          fleetView,
          promptOptions,
        )
      : buildChatContext(remediationEnabled, fleetView, promptOptions, mode);
  const provider = createProvider(systemPrompt, llm, apiKey);

  createSession(
    buildSessionMeta(sessionId, alert, input.userMessage),
    alert,
    mode,
  );

  let persistedCount = 0;
  const seqOffset = getNextSeq(sessionId) - (input.seed?.length ?? 0);

  if (input.resumeToolResults && input.resumeToolResults.length > 0) {
    // Resume from a durable interrupt: seed the prior transcript, then append
    // the resolved tool_results turn so the next chat() sees a complete context.
    if (input.seed) {
      provider.seed(input.seed);
      persistedCount = input.seed.length;
    }
    provider.appendToolResults(input.resumeToolResults);
    persistedCount = persistNewTurns(
      provider,
      sessionId,
      persistedCount,
      seqOffset,
    );
  } else if (input.seed && input.seed.length > 0) {
    provider.seed(input.seed);
    persistedCount = input.seed.length;
    // Persist the new user turn immediately so the console shows it the moment
    // it's sent, instead of waiting for the assistant's reply to flush both at once.
    if (input.userMessage) {
      provider.appendUserMessage(input.userMessage);
      persistedCount = persistNewTurns(
        provider,
        sessionId,
        persistedCount,
        seqOffset,
      );
    }
  } else {
    provider.start(input.userMessage ?? firstUserMessage);
    persistedCount = persistNewTurns(
      provider,
      sessionId,
      persistedCount,
      seqOffset,
    );
    // Brand-new session only: refine the title in the background. Chat uses the
    // message; an alert, a compact summary.
    const titleSource = input.userMessage ?? buildAlertTitleSource(allAlerts);
    void generateSessionTitle(sessionId, titleSource, llm, apiKey);
  }

  const persist = (): void => {
    persistedCount = persistNewTurns(
      provider,
      sessionId,
      persistedCount,
      seqOffset,
    );
  };

  let turn = 0;
  let nudges = 0;
  let deadline = Date.now() + config.hardTimeoutMs;

  while (Date.now() < deadline) {
    turn++;

    const fleetCapabilities = currentFleetCapabilities();
    // Re-read per turn like the remediation switch: disconnecting an
    // integration strips its tools from the very next turn.
    const toolset = effectiveToolset(
      fleetCapabilities,
      currentRemediationEnabled(),
      {
        github: getGitHubIntegration() !== null,
        prometheus: getPrometheusIntegration() !== null,
        loki: getLokiIntegration() !== null,
      },
      mode,
    );
    const toolSchemas = toolset.map((t) => t.schema);

    const startedAt = Date.now();
    let response: ChatResponse;
    try {
      response = await chatWithRetries(provider, toolSchemas);
    } catch (err) {
      if (signal?.aborted) {
        log.info({ turn }, "run stopped by user");
        persist();
        return "stopped";
      }
      throw err;
    }
    if (signal?.aborted) {
      log.info({ turn }, "run stopped by user");
      persist();
      return "stopped";
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
      return "completed";
    }

    if (response.toolUses.length === 0) {
      // Finish gate: an investigate run may only end with a complete report.
      // Push back up to MAX_NUDGES times, then finalize honestly as inconclusive.
      if (mode === "investigate" && !reportComplete(sessionId)) {
        if (nudges < MAX_NUDGES) {
          nudges++;
          log.info({ turn, nudges }, "finish gate: report incomplete, nudging");
          provider.appendUserMessage(GATE_NUDGE);
          persist();
          continue;
        }
        log.warn(
          { turn },
          "finish gate: nudge cap reached, finalizing inconclusive",
        );
        finalizeInconclusive(sessionId, llm.model);
      }
      log.info({ turn }, "investigation finished with free-form response");
      return "completed";
    }

    const execCtx: Omit<ToolExecuteContext, "toolUseId"> = {
      toolTimeoutMs: config.toolTimeoutMs,
      sessionId,
    };

    const { toolResults, gated } = await processToolUses({
      toolUses: response.toolUses,
      toolset,
      sessionId,
      execCtx,
      config,
      log,
    });

    // Repo tools re-extend the deadline to the code-session budget since clone
    // + install + tests dwarf the investigation default.
    if (response.toolUses.some((t) => REPO_TOOL_NAMES.has(t.name))) {
      deadline = Math.max(deadline, Date.now() + config.codeSessionBudgetMs);
    }

    if (gated !== null) {
      // Durably suspend: persist assistant turn + interrupt row in one transaction, then exit and
      // free the slot. Suspended sessions take no injections, so the inbox isn't drained here.
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
        seqOffset,
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
      publishTranscriptItem({
        sessionId,
        item: toolCallCard({
          toolUseId: gated.tool.id,
          toolName: gated.tool.name,
          input: gated.tool.input,
          state: { phase: "awaiting_human" },
          awaitingKind: isAskGate ? "clarification" : "approval",
        }),
      });
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
      return "suspended";
    }

    // Drain mid-run injected alerts at the tool boundary, riding the tool-results user turn so
    // the provider never sees two consecutive user turns; the model judges each as downstream vs independent.
    const injected = dispatcher.drainInbox(sessionId);
    const injectionText =
      injected.length > 0 ? formatInjectedAlerts(injected) : undefined;

    provider.appendToolResults(toolResults, injectionText);
    persist();
  }

  // No underlying tool call, so the synthetic toolUseId only keys the
  // interrupt row - the resolver branches on kind, not the transcript.
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
    seqOffset,
    continueInterrupt,
  );
  publishTranscriptItem({
    sessionId,
    item: toolCallCard({
      toolUseId: continueId,
      toolName: "",
      input: {},
      state: { phase: "awaiting_human" },
      awaitingKind: "continue",
    }),
  });
  publishInterrupt({
    sessionId,
    toolUseId: continueId,
    toolName: "",
    input: {},
    kind: "continue",
  });
  log.info({ turn }, "time budget reached: suspended with continue request");
  return "suspended";
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
