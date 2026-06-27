import { randomUUID } from "node:crypto";
import { buildInitialContext, buildChatContext } from "./context.js";
import {
  effectiveToolset,
  toolSupportsProvider,
  executeTool,
} from "./tools.js";
import type { Provider, Tool, ToolExecuteContext } from "./tools.js";
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
  publishToolCallStart,
  publishInterrupt,
  publishToolCallEnd,
  publishRunStopped,
} from "../session/stream.js";
import { dispatcher } from "../dispatcher.js";
import {
  getFleetView,
  getRunnerManifestForAlert,
  listRunners,
} from "../ws/router.js";
import { getRemediationModeByRunnerRef } from "../db/runner.js";
import { logger } from "../logger.js";
import {
  countExecutedRemediations,
  serviceIdentityKeyFromInput,
} from "../db/remediation-actions.js";
import type {
  AgentConfig,
  NormalizedAlert,
  SessionMessage,
  SessionMeta,
} from "@nightwatch/shared";
import type {
  ChatResponse,
  LLMProvider,
  ProviderMessage,
  ToolResult,
  ToolUse,
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

// The providers filter (ADR-0002) is keyed on the whole connected fleet, not
// just the alerting runner - a mixed-fleet investigation (user story 7) may
// still call agnostic tools against a sibling runner of either provider.
// Returns undefined (no filter, every tool shown) when no runner has reported
// a manifest yet, so a quiet fleet never hides tools the agent could need.
function currentFleetProviders(): ReadonlySet<Provider> | undefined {
  const providers = new Set<Provider>();
  for (const runner of listRunners()) {
    if (!runner.manifest) continue;
    if (runner.manifest.capabilities.docker) providers.add("docker");
    if (runner.manifest.capabilities.kubernetes) providers.add("kubernetes");
  }
  return providers.size > 0 ? providers : undefined;
}

// Remediation mode is the master write switch (ADR-0003), and the API's DB is
// its system of record. We read the DB directly - not an in-memory cache - so a
// run resumed after an API restart sees the operator's setting even before the
// runner has reconnected (a stale/empty cache would otherwise flip a remediating
// run silently read-only). A null DB value (the runner has never been
// reconciled) falls back to the runner's live manifest self-report so a freshly
// added runner is not silently read-only.
function currentRemediationEnabled(runnerId?: string): boolean {
  if (runnerId) {
    const dbMode = getRemediationModeByRunnerRef(runnerId);
    if (dbMode !== null) return dbMode;
    return (
      getRunnerManifestForAlert(runnerId)?.capabilities.remediationEnabled ??
      false
    );
  }
  for (const runner of listRunners()) {
    if (runner.remediationMode === true) return true;
    if (
      runner.remediationMode === null &&
      runner.manifest?.capabilities.remediationEnabled
    )
      return true;
  }
  return false;
}

// Returns the service's provider string if it does not match the tool's
// declared providers (e.g. a Kubernetes-only tool called with a docker
// identity), so the model gets a corrective error instead of acting on the
// wrong provider (ADR-0002, user story 19). Tools with no `service` input,
// or a provider value the tool does support, are never mismatched.
function mismatchedServiceProvider(
  input: Record<string, unknown>,
  entry: Tool,
): string | null {
  const service = input["service"];
  if (typeof service !== "object" || service === null) return null;
  const provider = (service as Record<string, unknown>)["provider"]; // typeof guard above confirms object shape
  if (typeof provider !== "string") return null;
  return toolSupportsProvider(entry, provider) ? null : provider;
}

// Circuit breaker: before a write suspends for approval, refuse it outright when
// too many writes to the same (service identity, action) have already landed in
// the window, so a crash-loop "fix" cannot become a restart storm and the
// operator is never asked to approve one. Returns a corrective tool_result (the
// same self-correction pattern as a provider mismatch) when tripped, or null to
// let the write proceed to the approval card. A write with no service identity
// cannot be keyed and is never breaker-refused.
function circuitBreakerRejection(
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
  log.info(
    {
      target: alert?.targetIdentifier ?? "chat",
      severity: alert?.severity ?? "info",
      isChat: alert == null,
    },
    "investigation started",
  );

  const config = loadConfig();
  const apiKey = loadApiKey();

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

  const sessionMeta: SessionMeta = {
    sessionId,
    // null alert = chat session; title from user message. alert session = alert type + target.
    title:
      alert == null && input.userMessage
        ? input.userMessage.slice(0, 80)
        : `${alert?.alertType ?? "chat"} - ${alert?.targetIdentifier ?? "chat"}`,
    createdAt: new Date().toISOString(),
  };
  createSession(sessionMeta, alert);

  let persistedCount = 0;

  // Operator declined a continue-request interrupt: run one free-form wrap-up
  // turn with no tools so the model can summarize, then finish.
  if (input.wrapUp) {
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
    persistedCount = persistNewTurns(provider, sessionId, persistedCount);
    if (signal?.aborted) {
      publishRunStopped(sessionId);
      log.info("run stopped by user during end wrap-up");
      return;
    }
    log.info("investigation ended after operator declined to continue");
    return;
  }

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

  // Resolve the effective tool set ONCE per run invocation from the run-level
  // remediation mode and fleet providers. The same set backs both the schemas
  // offered to the model and the names the loop resolves below, so the system
  // prompt (built from the same remediationEnabled) and the tool menu can never
  // disagree within a run, and a resume recomputes it fresh.
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

    // Two-pass: execute non-gated tools first, accumulate their results, then
    // suspend on the first gated tool. Non-gated results become completedResults
    // on the interrupt row so the resume can assemble the single tool_results
    // message the provider contract requires (D9, D10).
    const toolResults: ToolResult[] = [];
    let gatedTool: ToolUse | null = null;
    let gatedEntry: Tool | null = null;

    const execCtx: ToolExecuteContext = {
      runnerId: alert?.runnerId ?? undefined,
      toolTimeoutMs: config.toolTimeoutMs,
    };

    for (const tool of response.toolUses) {
      // Resolve against the effective tool set, not the full registry: a tool
      // stripped by remediation mode or fleet providers is genuinely unavailable,
      // so a model that names it is told "unknown tool" and never reaches the
      // approval gate. This is what makes the master write switch unbypassable.
      const entry = toolset.find((t) => t.schema.name === tool.name);

      if (!entry) {
        log.warn({ tool: tool.name }, "LLM requested unavailable tool");
        toolResults.push({
          tool_use_id: tool.id,
          content: `Tool "${tool.name}" is not available in this investigation. Do not retry.`,
          is_error: true,
        });
        continue;
      }

      const mismatchedProvider = mismatchedServiceProvider(tool.input, entry);
      if (mismatchedProvider) {
        log.warn(
          { tool: tool.name, provider: mismatchedProvider },
          "provider-specific tool called with mismatched service identity",
        );
        toolResults.push({
          tool_use_id: tool.id,
          content: `Provider mismatch: "${tool.name}" only supports [${(entry.providers ?? []).join(", ")}], but was called with a "${mismatchedProvider}" service identity. Echo the service identity as received; use an agnostic tool, or a tool matching that provider, instead. Do not retry this call as-is.`,
          is_error: true,
        });
        continue;
      }

      if (entry.access === "write" || entry.access === "ask") {
        if (gatedTool !== null) {
          // Only one gate per turn; reject subsequent gated tools so every
          // tool_use in this assistant message still gets a tool_result (D10).
          toolResults.push({
            tool_use_id: tool.id,
            content:
              "Another gated action is pending. Retry after it resolves.",
            is_error: true,
          });
          continue;
        }

        if (entry.access === "write") {
          const breakerRejection = circuitBreakerRejection(tool, config);
          if (breakerRejection) {
            log.warn(
              { tool: tool.name },
              "circuit breaker tripped: write refused without approval",
            );
            toolResults.push(breakerRejection);
            continue;
          }
        }

        gatedTool = tool;
        gatedEntry = entry;
        continue;
      }

      // access === "read": execute immediately
      publishToolCallStart({
        sessionId,
        toolUseId: tool.id,
        toolName: tool.name,
        input: tool.input,
      });
      const result = await executeTool(entry, tool.input, execCtx);
      toolResults.push({
        tool_use_id: tool.id,
        content:
          typeof result.content === "string"
            ? result.content
            : JSON.stringify(result.content),
        is_error: result.is_error,
      });
      publishToolCallEnd({
        sessionId,
        toolUseId: tool.id,
        result: result.content,
        isError: result.is_error,
      });
    }

    if (gatedTool !== null && gatedEntry !== null) {
      // Durably suspend: persist the assistant turn + interrupt row in ONE
      // transaction (D3). The run then exits and frees its dispatcher slot.
      // Suspended sessions never receive injections: the inbox is NOT drained
      // here; any inbox alerts become new sessions via the dispatcher's finally.
      const isAskGate = gatedEntry.access === "ask";
      const interrupt: PendingHumanInput = {
        sessionId,
        toolUseId: gatedTool.id,
        kind: isAskGate ? "clarification" : "approval",
        toolName: gatedTool.name,
        toolInput: gatedTool.input,
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
        kind: isAskGate ? "clarification" : "approval",
        ...(clarInput !== null && {
          question: clarInput.question,
          options: clarInput.options,
          multiSelect: clarInput.multiSelect,
        }),
      });
      log.info(
        { tool: gatedTool.name, kind: interrupt.kind },
        "run suspended: pending human input",
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

  // Time budget reached. Suspend with a continue-request interrupt so the
  // operator can resume (granting a fresh deadline) or end the investigation.
  // The interrupt row is inserted atomically; all prior turns are already
  // persisted so the messages list passed here is empty.
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
