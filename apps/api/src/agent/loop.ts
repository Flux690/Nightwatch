import { randomUUID } from "node:crypto";
import { buildInitialContext, buildChatContext } from "./context.js";
import type { PromptOptions } from "./prompts/system.js";
import {
  completionRequest,
  compositionRequest,
  compositionRetry,
} from "./prompts/report.js";
import { gatedCalls, reportGaps, type ReportGap } from "./report.js";
import { SUBMIT_REPORT_TOOL } from "./tools/report.js";
import { getReport } from "../db/reports.js";
import { verifyRecovery } from "../verification/recovery.js";
import { effectiveToolset } from "./tools/toolset.js";
import type { ToolDispatchContext } from "./tools/types.js";
import { connectedPlatforms } from "./policy.js";
import { processToolUses } from "./turn.js";
import { retrySummary, withLLMRetries } from "../llm/failures.js";
import { retryDelaysMs } from "../llm/config.js";
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
  appendErrorMessage,
  appendSessionAlert,
  appendTranscriptRows,
  appendRowsAndInterrupt,
  getNextSeq,
  getSession,
} from "../db/sessions.js";
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
import { getFleetView } from "../ws/fleet.js";
import { logger } from "../logger.js";
import type {
  NormalizedAlert,
  SubmittedReport,
  TranscriptRow,
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

// Writes the provider-snapshot diff atomically; seq = seqOffset + snapshot index
// so rows the seed skipped never collide. `harnessTurns` names the indices
// NightWarden authored, which the provider cannot tell from the operator's.
function persistNewTurns(
  provider: LLMProvider,
  sessionId: string,
  fromCount: number,
  seqOffset: number,
  harnessTurns: ReadonlySet<number>,
  interrupt?: PendingHumanInput,
): number {
  const snap = provider.snapshot();
  const newMessages: TranscriptRow[] = [];
  for (let i = fromCount; i < snap.length; i++) {
    const m = snap[i];
    if (!m) continue;
    newMessages.push({
      sessionId,
      seq: seqOffset + i,
      kind: harnessTurns.has(i) ? "nightwarden" : m.role,
      content: m.content,
      parts: m.parts,
      ...(m.native && { native: m.native }),
      createdAt: new Date().toISOString(),
    });
  }
  if (interrupt) {
    appendRowsAndInterrupt(newMessages, interrupt);
  } else {
    appendTranscriptRows(newMessages);
  }
  // A harness row draws nothing, so publishing it would only cost the console a
  // transcript refetch that changes no pixel.
  for (const message of newMessages) {
    if (message.kind !== "nightwarden") publishMessage(sessionId, message);
  }
  return snap.length;
}

// null alert = chat session; title from user message. A placeholder either way: the
// title model replaces it seconds later, so the alert type alone is enough here.
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
        : (alert?.alertType ?? "chat"),
    createdAt: new Date().toISOString(),
  };
}

// How a run ended, so the dispatcher (the single lifecycle owner) can emit the
// one matching terminal event. A thrown error is the 4th state, "failed",
// handled by the dispatcher's catch - never returned here.
export type RunOutcome = "completed" | "suspended" | "stopped";

// Finish-gate pushback cap: after this many nudges the run composes anyway
// rather than looping; the time budget bounds it as well.
const MAX_NUDGES = 3;

// The composition turn has one tool and one job, so a second failure is a model
// that cannot do it rather than one that misread the request.
const MAX_COMPOSE_ATTEMPTS = 2;

/* What is wrong with the report that was just written, read back from the
   record rather than from the call that wrote it. The composition turn is the
   one moment the model authors prose, so what it may not leave out is checked
   here rather than trusted. */
function compositionProblem(
  submitted: SubmittedReport | null,
  unrecovered: "still_firing" | "unconfirmed" | null,
): string | null {
  if (submitted === null) {
    return "You ended the turn without writing the report.";
  }
  if (submitted.summary.trim() === "") return "Your report has no summary.";
  if (unrecovered !== null && submitted.recommendation.trim() === "") {
    return unrecovered === "still_firing"
      ? "A write you released has run, the condition that opened this investigation is still firing, and your report recommends nothing."
      : "A write you released has run, nothing can confirm the condition recovered, and your report recommends nothing.";
  }
  return null;
}

export interface RunSessionInput {
  sessionId: string;
  // Everything that fired inside the 90s batch window, all of it opening this
  // session. No member is elected: they are investigated as one incident.
  // Absent on a resume, which recovers them from the session row.
  alerts?: NormalizedAlert[];
  seed?: ProviderMessage[];
  userMessage?: string;
  // The operator picked Investigate before they typed. An alert says the same
  // thing by existing; absent on a resume, which reads the session's own row.
  investigation?: boolean;
  // Present on resume: the full tool_results for the suspended turn
  // (completedResults from interrupt row + the newly resolved gated result).
  resumeToolResults?: ToolResult[];
  // Aborts the LLM request in flight when the dispatcher stops this run.
  signal?: AbortSignal;
  // When true: seed prior transcript and run exactly one wrap-up turn (no tools),
  // then finish. Used when the operator declines a continue-request interrupt.
  wrapUp?: boolean;
}

export async function runSession(input: RunSessionInput): Promise<RunOutcome> {
  const { sessionId, signal } = input;

  const stored = getSession(sessionId);
  // A resume carries none, so the session's own record answers instead.
  const allAlerts =
    input.alerts ?? (stored?.alerts ?? []).map((entry) => entry.alert);
  const alert = allAlerts[0] ?? null;

  // An alert opens an investigation; otherwise the session's own row answers,
  // never an artifact a previous run happened to leave behind. The row is the
  // one-way ratchet, so this can only ever turn on.
  const opensInvestigation =
    allAlerts.length > 0 ||
    (input.investigation ?? false) ||
    (stored?.investigation ?? false);

  const log = logger.child({
    sessionId,
    alertType: alert?.alertType ?? "chat",
    alertCount: allAlerts.length,
    investigation: opensInvestigation,
  });

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
    // The run's effective signal: the operator's stop, or that combined with
    // the investigation deadline once the loop has one.
    chatSignal: AbortSignal | undefined = signal,
  ): Promise<ChatResponse> =>
    withLLMRetries(
      () =>
        provider.chat(
          toolSchemas,
          (d) => publishTextMessageContent(sessionId, d),
          chatSignal,
        ),
      {
        signal: chatSignal,
        delays: retryDelaysMs(config.maxRetries),
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

  // Snapshot indices NightWarden wrote. Recorded as each message is sent, since
  // by the time the diff is persisted a harness turn is indistinguishable from
  // one the operator typed.
  const harnessTurns = new Set<number>();
  const sendHarnessMessage = (provider: LLMProvider, text: string): void => {
    provider.appendUserMessage(text);
    harnessTurns.add(provider.snapshot().length - 1);
  };

  // Operator declined a continue-request: replay the transcript and run one free-form
  // wrap-up turn (no tools). Seed already carries the investigation, so skip the alert/fleet context build below.
  if (input.wrapUp) {
    const { systemPrompt } = buildChatContext(
      undefined,
      undefined,
      opensInvestigation,
    );
    const provider = createProvider(systemPrompt, llm, apiKey);
    createSession(
      buildSessionMeta(sessionId, alert, input.userMessage),
      allAlerts,
      opensInvestigation,
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
    persistNewTurns(
      provider,
      sessionId,
      persistedCount,
      seqOffset,
      harnessTurns,
    );
    if (signal?.aborted) {
      log.info("run stopped by user during end wrap-up");
      return "stopped";
    }
    log.info("investigation ended after operator declined to continue");
    return "completed";
  }

  log.info(
    {
      alertLabels: alert?.labels ?? null,
      severity: alert?.severity ?? null,
      isChat: alert == null,
    },
    "investigation started",
  );

  const fleetView = getFleetView();
  const integration = getGitHubIntegration();
  const promptOptions: PromptOptions = {
    budgetMinutes: Math.max(1, Math.round(config.checkInAfterMs / 60_000)),
    repo:
      integration === null
        ? null
        : `${integration.repoOwner}/${integration.repoName}`,
  };
  const { systemPrompt, openingTurn } =
    allAlerts.length > 0
      ? buildInitialContext(allAlerts, fleetView, promptOptions)
      : buildChatContext(fleetView, promptOptions, opensInvestigation);
  const provider = createProvider(systemPrompt, llm, apiKey);

  createSession(
    buildSessionMeta(sessionId, alert, input.userMessage),
    allAlerts,
    opensInvestigation,
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
      harnessTurns,
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
        harnessTurns,
      );
    }
  } else {
    // An alert has no human to type the first turn, so NightWarden writes it.
    // A person's own first message is theirs, and is marked as neither.
    provider.start(input.userMessage ?? openingTurn ?? "");
    if (input.userMessage === undefined && openingTurn !== null) {
      harnessTurns.add(0);
    }
    persistedCount = persistNewTurns(
      provider,
      sessionId,
      persistedCount,
      seqOffset,
      harnessTurns,
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
      harnessTurns,
    );
  };

  let turn = 0;
  let nudges = 0;
  // How many completion requests each gap has survived, so a repeat is loud.
  const gapsSeen = new Map<ReportGap["kind"], number>();
  // Computed once and never moved, so a run cannot outrun its own clock: every
  // turn spends the same budget and the check-in below always arrives.
  const deadline = Date.now() + config.checkInAfterMs;
  // Propagated into the model request and every tool call so the budget is one
  // shared instant, not a duration each layer counts separately. Distinct from
  // `signal`, which means the operator stopped the run.
  const outOfTime = AbortSignal.timeout(config.checkInAfterMs);
  const runSignal = signal ? AbortSignal.any([signal, outOfTime]) : outOfTime;

  /* The composition turn: every investigation tool is taken away and one is put
     back, so the only thing the model can do from here is the thing being asked
     of it. The ledger rides the request rather than being left to context - the
     timeline copies call ids verbatim, and turn forty is the worst place to copy
     a string from. An ending without a report is still an ending: the record
     renders on its own. */
  const compose = async (
    unrecovered: "still_firing" | "unconfirmed" | null,
    turn: number,
  ): Promise<RunOutcome> => {
    let problem: string | null = null;
    for (let attempt = 1; attempt <= MAX_COMPOSE_ATTEMPTS; attempt++) {
      sendHarnessMessage(
        provider,
        problem === null
          ? compositionRequest(
              getReport(sessionId)?.hypotheses ?? [],
              gatedCalls(sessionId),
              unrecovered,
            )
          : compositionRetry(problem),
      );
      persist();

      let composed: ChatResponse;
      try {
        composed = await chatWithRetries(
          provider,
          [SUBMIT_REPORT_TOOL.schema],
          runSignal,
        );
      } catch (err) {
        if (signal?.aborted) {
          log.info("run stopped by user while composing the report");
          persist();
          return "stopped";
        }
        // The budget ran out with the record already complete. Ending without
        // the write-up is honest; pushing past the operator's ceiling is not.
        if (outOfTime.aborted) {
          log.warn("time budget reached while composing the report");
          persist();
          return "completed";
        }
        throw err;
      }
      persist();
      if (signal?.aborted) {
        log.info("run stopped by user while composing the report");
        return "stopped";
      }

      const { toolResults } = await processToolUses({
        toolUses: composed.toolUses,
        toolset: [SUBMIT_REPORT_TOOL],
        sessionId,
        execCtx: {
          sessionId,
          toolCallCeilingMs: config.toolCallCeilingMs,
        },
        log,
      });
      if (toolResults.length > 0) provider.appendToolResults(toolResults);
      persist();

      problem = compositionProblem(
        getReport(sessionId)?.submitted ?? null,
        unrecovered,
      );
      if (problem === null) {
        log.info({ turn, attempt }, "investigation report written");
        return "completed";
      }
      log.warn({ turn, attempt, problem }, "composition turn refused");
    }
    log.warn(
      { turn },
      "composition failed; the record stands without a report",
    );
    return "completed";
  };

  while (Date.now() < deadline) {
    turn++;

    const platforms = connectedPlatforms();
    // Re-read per turn: disconnecting an integration strips its tools from the
    // very next turn. What the session is cannot change mid-run, so it is not
    // re-read alongside them.
    const toolset = effectiveToolset(
      platforms,
      {
        github: getGitHubIntegration() !== null,
        prometheus: getPrometheusIntegration() !== null,
        loki: getLokiIntegration() !== null,
      },
      opensInvestigation,
    );
    const toolSchemas = toolset.map((t) => t.schema);

    const startedAt = Date.now();
    let response: ChatResponse;
    try {
      response = await chatWithRetries(provider, toolSchemas, runSignal);
    } catch (err) {
      if (signal?.aborted) {
        log.info({ turn }, "run stopped by user");
        persist();
        return "stopped";
      }
      // The budget cut the turn short. That is the check-in below, not a
      // failure, so it leaves the loop rather than killing the run.
      if (outOfTime.aborted) {
        log.info({ turn }, "time budget reached mid-turn");
        persist();
        break;
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

    // A turn cut off at max_tokens is not a finished answer, and its last tool
    // call may carry truncated arguments. Say so rather than reading the stump
    // as a conclusion.
    if (response.stopReason === "max_tokens") {
      log.warn({ turn, model: llm.model }, "turn truncated at max_tokens");
      appendErrorMessage(
        sessionId,
        `The model's reply was cut off at this model's output limit of ${llm.maxOutputTokens} tokens, so this turn is incomplete. Send a message to continue, or pick a model with a larger limit in Settings.`,
      );
      return "completed";
    }

    if (response.toolUses.length === 0) {
      if (!opensInvestigation) {
        log.info({ turn }, "chat finished with free-form response");
        return "completed";
      }
      // Ledger gate: the record must be complete before it can be written up.
      // Push back up to MAX_NUDGES times, then compose from what there is - the
      // status an unfinished record derives to is already the honest one.
      const gaps = reportGaps(sessionId);
      // Asked here rather than on the read path: this is the one moment the
      // answer changes what happens next, and the investigations list reads
      // status once per row. Run on every attempt - stamping a recovered
      // condition keeps the record true even when the alert source never sent a
      // resolved notification.
      const recovery = await verifyRecovery(sessionId);
      if (gaps.length > 0) {
        if (nudges < MAX_NUDGES) {
          nudges++;
          for (const gap of gaps) {
            const seen = (gapsSeen.get(gap.kind) ?? 0) + 1;
            gapsSeen.set(gap.kind, seen);
            // A gap that outlives its own request is a broken tool or a
            // description the model cannot act on, not a distracted model.
            if (seen > 1) {
              log.warn(
                { turn, gap: gap.kind, requests: seen },
                "finish gate: gap survived a completion request",
              );
            }
          }
          log.info(
            { turn, nudges, gaps: gaps.map((g) => g.kind), recovery },
            "finish gate: record incomplete, requesting completion",
          );
          sendHarnessMessage(provider, completionRequest(gaps));
          persist();
          continue;
        }
        log.warn(
          { turn, gaps: gaps.map((g) => g.kind), recovery },
          "finish gate: request cap reached, composing incomplete",
        );
      }
      /* Only a run that acted must recommend. "I could not work out the cause,
         here is what I ruled out" is a complete ending - but a run that had the
         operator release a write and then went quiet has left them nothing.
         Both an unrecovered condition and an unanswerable one qualify; which of
         the two it was decides what the request says, because they are not the
         same claim. */
      const released = gatedCalls(sessionId).some(
        (c) => c.decision === "approved",
      );
      const unrecovered =
        released && (recovery === "still_firing" || recovery === "unconfirmed")
          ? recovery
          : null;
      return compose(unrecovered, turn);
    }

    const execCtx: Omit<ToolDispatchContext, "toolUseId"> = {
      // Already clamped by what remains of the investigation, so no tool call
      // can outlive the budget it is being spent from.
      toolCallCeilingMs: Math.max(
        0,
        Math.min(config.toolCallCeilingMs, deadline - Date.now()),
      ),
      sessionId,
    };

    const { toolResults, gated } = await processToolUses({
      toolUses: response.toolUses,
      toolset,
      sessionId,
      execCtx,
      log,
    });

    if (gated !== null) {
      // Durably suspend: persist assistant turn + interrupt row in one transaction, then exit and
      // free the slot. Suspended sessions take no injections, so the inbox isn't drained here.
      const isAskGate = gated.entry.access === "ask";
      const interrupt: PendingHumanInput = {
        sessionId,
        toolUseId: gated.tool.id,
        kind: isAskGate ? "clarification" : "approval",
        completedResults: toolResults,
        claimedAt: null,
      };
      persistedCount = persistNewTurns(
        provider,
        sessionId,
        persistedCount,
        seqOffset,
        harnessTurns,
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

    // Drain mid-run injected alerts at the tool boundary - the earliest point the
    // model can act on one - as their own turn after the results. The model judges
    // each as downstream of this incident or independent of it.
    provider.appendToolResults(toolResults);
    const injected = dispatcher.drainInbox(sessionId);
    if (injected.length > 0) {
      for (const alert of injected) appendSessionAlert(sessionId, alert);
      sendHarnessMessage(provider, formatInjectedAlerts(injected));
    }
    persist();
  }

  // No underlying tool call, so the synthetic toolUseId only keys the
  // interrupt row - the resolver branches on kind, not the transcript.
  const continueId = randomUUID();
  const continueInterrupt: PendingHumanInput = {
    sessionId,
    toolUseId: continueId,
    kind: "continue",
    completedResults: [],
    claimedAt: null,
  };
  persistedCount = persistNewTurns(
    provider,
    sessionId,
    persistedCount,
    seqOffset,
    harnessTurns,
    continueInterrupt,
  );
  publishTranscriptItem({
    sessionId,
    item: toolCallCard({
      toolUseId: continueId,
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

// An injected alert names itself by its labels: the run is already under way, so
// the fleet summary it was opened with is the map the agent matches them against.
function formatLabels(labels: Record<string, string>): string {
  const rendered = Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  return rendered || "no labels";
}

// Its own turn now, so it opens rather than continues: no leading blank lines.
function formatInjectedAlerts(alerts: NormalizedAlert[]): string {
  const header =
    alerts.length === 1
      ? "Another alert has fired while you were working. Decide whether it is a downstream effect of the incident you are investigating or an independent one, and say which."
      : `${alerts.length} further alerts have fired while you were working. For each, decide whether it is a downstream effect of the incident you are investigating or an independent one, and say which.`;
  return (
    header +
    "\n" +
    alerts
      .map(
        (a) =>
          `- [${a.alertType}] ${formatLabels(a.labels)} (${a.severity}) fired at ${a.firedAt} [id: ${a.sourceAlertId}]`,
      )
      .join("\n")
  );
}
