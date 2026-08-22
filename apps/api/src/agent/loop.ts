import { randomUUID } from "node:crypto";
import { buildInitialContext, buildChatContext } from "./context.js";
import type { PromptOptions } from "./prompts/system.js";
import {
  completionRequest,
  recordCheck,
  reportRequest,
  reportRetry,
} from "./prompts/report.js";
import { gatedCalls, reportGaps, type ReportGap } from "./report.js";
import { evidenceIdsByToolUseId } from "./evidence-id.js";
import { SUBMIT_REPORT_TOOL } from "./tools/report.js";
import { getReport } from "../db/reports.js";
import { recoveryState } from "../verification/recovery.js";
import {
  effectiveToolset,
  offeredSchemas,
  type OfferedToolset,
} from "./tools/toolset.js";
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
  getLokiIntegration,
} from "../db/integrations.js";
import { hasMetricsSource } from "../integrations/metrics/sources.js";
import {
  appendErrorMessage,
  appendTranscriptRows,
  getTranscriptRows,
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
import { continueCard, toolCallCard } from "../session/transcript.js";
import type { ReportCardItem } from "@nightwarden/shared";
import {
  generateSessionTitle,
  buildAlertTitleSource,
} from "../session/title.js";
import { dispatcher } from "../dispatcher.js";
import { getFleetView } from "../ws/fleet.js";
import { logger } from "../logger.js";
import type {
  AlertGroupContext,
  MessagePart,
  NormalizedAlert,
  SubmittedReport,
  ToolName,
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

/* Neither `toolOutcome` nor `humanDecision` is a wire field, so a provider snapshot
   always comes back without them. The run knew both before the row existed; this
   puts them back. */
type ResultAnnotation = Pick<ToolResult, "toolOutcome" | "humanDecision">;

function stampOutcomes(
  parts: MessagePart[],
  annotations: ReadonlyMap<string, ResultAnnotation>,
): MessagePart[] {
  if (annotations.size === 0) return parts;
  return parts.map((part) => {
    if (part.type !== "tool_result") return part;
    const noted = annotations.get(part.toolCallId);
    if (noted === undefined) return part;
    return {
      ...part,
      ...(noted.toolOutcome !== undefined && {
        toolOutcome: noted.toolOutcome,
      }),
      ...(noted.humanDecision !== undefined && {
        humanDecision: noted.humanDecision,
      }),
    };
  });
}

// The seq a turn will be saved under, computed the way persistNewTurns computes
// it below. Streaming happens first, so the console is told it in advance.
function turnSeq(provider: LLMProvider, seqOffset: number): number {
  return seqOffset + provider.snapshot().length;
}

function persistNewTurns(
  provider: LLMProvider,
  sessionId: string,
  fromCount: number,
  seqOffset: number,
  harnessTurns: ReadonlySet<number>,
  toolOutcomes: ReadonlyMap<string, ResultAnnotation>,
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
      parts: stampOutcomes(m.parts, toolOutcomes),
      ...(m.native && { native: m.native }),
      timestamp: new Date().toISOString(),
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

// What the fleet and the connected integrations currently allow. Read together,
// because the prompt describing them is built from the same call.
function currentToolset(investigation: boolean): OfferedToolset {
  return effectiveToolset(
    connectedPlatforms(),
    {
      github: getGitHubIntegration() !== null,
      metrics: hasMetricsSource(),
      loki: getLokiIntegration() !== null,
    },
    investigation,
  );
}

/* What to tell the model when its options change under it, or null when they
   have not. Names only the difference: a run thirty turns deep does not need its
   whole toolset restated, and the tools themselves carry their own descriptions. */
function toolsetChange(
  before: OfferedToolset,
  after: OfferedToolset,
): string | null {
  const was = new Set(before.tools.map((t) => t.schema.name));
  const now = new Set(after.tools.map((t) => t.schema.name));
  const gained = [...now].filter((n) => !was.has(n));
  const lost = [...was].filter((n) => !now.has(n));
  if (gained.length === 0 && lost.length === 0) return null;
  const lines: string[] = [];
  if (gained.length > 0) {
    lines.push(
      `Something connected while you were working, so these tools are available to you now: ${gained.join(", ")}.`,
    );
  }
  if (lost.length > 0) {
    lines.push(
      `Something disconnected while you were working, so these tools are no longer available and calling one will be refused: ${lost.join(", ")}. Anything they already told you stays on the record.`,
    );
  }
  return lines.join(" ");
}

// One id, because a session has one report: a later phase replaces the card
// rather than stacking a second one under the first.
function publishReportCard(
  sessionId: string,
  phase: ReportCardItem["state"]["phase"],
): void {
  publishTranscriptItem({
    sessionId,
    item: { kind: "report_card", id: "report", state: { phase } },
  });
}

/* null alert = chat session; title from user message. A placeholder either way:
   the title model replaces it seconds later. Shared with the chat route, which
   writes the row before handing out its id. */
export function buildSessionMeta(
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

// Finish-gate pushback cap: after this many nudges the run writes up anyway
// rather than looping; the time budget bounds it as well.
const MAX_NUDGES = 3;

// Consecutive turns that asked for nothing but unavailable tools. Three is
// enough to tell a wrong guess from a model with nothing left to try.
const MAX_BARREN_TURNS = 3;

/* The report turn has one tool and one job. Three, matching the finish gate:
   repair loops stop paying off past that, and the first two are often spent on a
   field the model left blank rather than on the write-up itself. */
const MAX_REPORT_ATTEMPTS = 3;

/* Answered tool calls before the run is asked whether it has settled anything.
   Eight is past orientation - listing, logs, metrics and config are four calls
   of looking around - and long before the budget matters. A check, not a repair
   attempt: nothing has failed, the record is simply still empty. */
const CALLS_BEFORE_RECORD_CHECK = 8;

// What is wrong with the report just written, read back from the record rather
// than from the call that wrote it.
/* Only what the tool could not already refuse. Every field is required and
   non-blank at the tool, so a stored report has prose in all of them; what is
   left to check here is the turn that ended without calling the tool at all.
   A run whose condition never recovered is told so before it writes, by the
   recovery sentence in the request, rather than caught after. */
function problemWithReport(submitted: SubmittedReport | null): string | null {
  if (submitted === null) {
    /* Says only what is true of both ways to get here: the turn never called
       the tool, or it called it and the call was refused. Which one it was is
       already above - a refusal names the field it refused. */
    return "The report has not been written.";
  }
  return null;
}

export interface RunSessionInput {
  sessionId: string;
  // The alert group opening this session, as the sender grouped it. No member is
  // elected: they are investigated as one incident. Absent on a resume, which
  // recovers them from the session row.
  alerts?: NormalizedAlert[];
  seed?: ProviderMessage[];
  userMessage?: string;
  // The user picked Investigate before they typed. An alert says the same
  // thing by existing; absent on a resume, which reads the session's own row.
  investigation?: boolean;
  // Present on resume: the full tool_results for the suspended turn
  // (completedResults from interrupt row + the newly resolved gated result).
  resumeToolResults?: ToolResult[];
  /* A turn NightWarden opens rather than the user, so it is stored as ours and
     never drawn: the reader pressed a button, and a sentence they did not write
     appearing in their own voice is a lie about who said what. */
  harnessMessage?: string;
  // Aborts the LLM request in flight when the dispatcher stops this run.
  signal?: AbortSignal;
  // When true: seed prior transcript and run exactly one closing turn (no tools),
  // then finish. Used when the user declines a continue-request interrupt.
  standDown?: boolean;
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
    turn: number,
    // The run's effective signal: the user's stop, or that combined with
    // the investigation deadline once the loop has one.
    chatSignal: AbortSignal | undefined = signal,
    forceTool?: ToolName,
  ): Promise<ChatResponse> =>
    withLLMRetries(
      () =>
        provider.chat(
          toolSchemas,
          (d) => publishTextMessageContent(sessionId, turn, d),
          chatSignal,
          forceTool,
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
  // one the user typed.
  const harnessTurns = new Set<number>();

  // Held for the run, not the turn: a resumed turn's results are stamped from
  // what the suspend parked rather than from tools this run ran.
  const seenOutcomes = new Map<string, ResultAnnotation>();
  const noteOutcomes = (results: readonly ToolResult[]): void => {
    for (const result of results) {
      if (
        result.toolOutcome === undefined &&
        result.humanDecision === undefined
      ) {
        continue;
      }
      seenOutcomes.set(result.tool_use_id, {
        ...(result.toolOutcome !== undefined && {
          toolOutcome: result.toolOutcome,
        }),
        ...(result.humanDecision !== undefined && {
          humanDecision: result.humanDecision,
        }),
      });
    }
  };

  /* Tagged, because a provider takes two roles and neither of them is ours: a
     harness turn is sent as the user's, and a model with no way to tell them
     apart answers NightWarden as though it were the person - apologising to
     them for something they never said. The row's `kind` is still what the
     console reads for origin; text can be typed, so it settles nothing there. */
  const sendHarnessMessage = (provider: LLMProvider, text: string): void => {
    provider.appendUserMessage(`<nightwarden>\n${text}\n</nightwarden>`);
    harnessTurns.add(provider.snapshot().length - 1);
  };

  // User declined a continue-request: replay the transcript and run one free-form
  // closing turn (no tools). Seed already carries the investigation, so skip the alert/fleet context build below.
  if (input.standDown) {
    const { systemPrompt } = buildChatContext(
      undefined,
      undefined,
      opensInvestigation,
    );
    const provider = createProvider(systemPrompt, llm, apiKey);

    let persistedCount = 0;
    const seqOffset = getNextSeq(sessionId) - (input.seed?.length ?? 0);
    if (input.seed && input.seed.length > 0) {
      provider.seed(input.seed);
      persistedCount = input.seed.length;
    }
    log.info("time budget ended: user chose to end, running closing turn");
    try {
      await chatWithRetries(provider, [], turnSeq(provider, seqOffset));
    } catch (err) {
      if (!signal?.aborted) throw err;
    }
    persistNewTurns(
      provider,
      sessionId,
      persistedCount,
      seqOffset,
      harnessTurns,
      seenOutcomes,
    );
    if (signal?.aborted) {
      log.info("run stopped by user during the closing turn");
      return "stopped";
    }
    log.info("investigation ended after user declined to continue");
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
  // Assembled once, before the prompt that describes it, so the prose and the
  // tools it describes are derived from one value and cannot disagree.
  let offered = currentToolset(opensInvestigation);
  const promptOptions: PromptOptions = {
    budgetMinutes: Math.max(1, Math.round(config.checkInAfterMs / 60_000)),
    repo:
      integration === null
        ? null
        : `${integration.repoOwner}/${integration.repoName}`,
    fleetTools: offered.tools.some((t) => t.on === "runner"),
  };
  const { systemPrompt, openingTurn } =
    allAlerts.length > 0
      ? buildInitialContext(allAlerts, fleetView, promptOptions, {
          // The worst any delivery of this group admitted to leaving out.
          droppedAlerts: (stored?.alerts ?? []).reduce(
            (n, e) => Math.max(n, e.droppedAlerts),
            0,
          ),
          // The most recent delivery that described the group: later ones are
          // the same group re-notified, and the newest labels are the live ones.
          groupContext: (stored?.alerts ?? []).reduce<AlertGroupContext | null>(
            (latest, e) => e.groupContext ?? latest,
            null,
          ),
        })
      : buildChatContext(fleetView, promptOptions, opensInvestigation);
  const provider = createProvider(systemPrompt, llm, apiKey);

  let persistedCount = 0;
  const seqOffset = getNextSeq(sessionId) - (input.seed?.length ?? 0);

  if (input.resumeToolResults && input.resumeToolResults.length > 0) {
    // Resume from a durable interrupt: seed the prior transcript, then append
    // the resolved tool_results turn so the next chat() sees a complete context.
    noteOutcomes(input.resumeToolResults);
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
      seenOutcomes,
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
        seenOutcomes,
      );
    } else if (input.harnessMessage) {
      sendHarnessMessage(provider, input.harnessMessage);
      persistedCount = persistNewTurns(
        provider,
        sessionId,
        persistedCount,
        seqOffset,
        harnessTurns,
        seenOutcomes,
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
      seenOutcomes,
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
      seenOutcomes,
    );
  };

  let turn = 0;
  let nudges = 0;
  // Per name across the whole run, so the fourth ask is answered as the fourth.
  const refusedNames = new Map<string, number>();
  let barrenTurns = 0;
  // Tool calls that answered, and whether the run has been asked about its
  // still-empty record. Asked once: the finish gate covers a model that ignores it.
  let answeredCalls = 0;
  let recordChecked = false;
  // How many completion requests each gap has survived, so a repeat is loud.
  const gapsSeen = new Map<ReportGap["kind"], number>();
  // Computed once and never moved, so a run cannot outrun its own clock: every
  // turn spends the same budget and the check-in below always arrives.
  const deadline = Date.now() + config.checkInAfterMs;
  // Propagated into the model request and every tool call so the budget is one
  // shared instant, not a duration each layer counts separately. Distinct from
  // `signal`, which means the user stopped the run.
  const outOfTime = AbortSignal.timeout(config.checkInAfterMs);
  const runSignal = signal ? AbortSignal.any([signal, outOfTime]) : outOfTime;

  /* Every investigation tool taken away and one put back, so the only thing the
     model can do is the thing being asked. The ledger rides the request: turn
     forty is the worst place to copy a call id from. */
  const writeReport = async (
    unrecovered: boolean,
    turn: number,
  ): Promise<RunOutcome> => {
    // Said out loud rather than only to the server log: an investigation with no
    // write-up looked exactly like one whose model chose not to write much.
    const notWritten = (why: string): RunOutcome => {
      log.warn({ turn }, "report turn failed; the record stands without one");
      appendErrorMessage(sessionId, `${why} Your findings below are complete.`);
      publishReportCard(sessionId, "failed");
      return "completed";
    };

    publishReportCard(sessionId, "building");
    let problem: string | null = null;
    for (let attempt = 1; attempt <= MAX_REPORT_ATTEMPTS; attempt++) {
      sendHarnessMessage(
        provider,
        problem === null
          ? reportRequest(
              getReport(sessionId)?.hypotheses ?? [],
              gatedCalls(sessionId),
              unrecovered,
              // The ledger is repeated here for the timeline to cite from, so it
              // has to name calls the way their results named themselves.
              evidenceIdsByToolUseId(getTranscriptRows(sessionId)),
              /* What a previous run already wrote, so a follow-up revises it
                 rather than rewriting it from a context that may since have been
                 compacted. Null on the first run, which has nothing to revise. */
              getReport(sessionId)?.submitted ?? null,
            )
          : reportRetry(problem),
      );
      persist();

      let written: ChatResponse;
      try {
        written = await chatWithRetries(
          provider,
          [SUBMIT_REPORT_TOOL.schema],
          turnSeq(provider, seqOffset),
          runSignal,
          // One tool and one job, so the turn cannot come back as prose. It has:
          // a model once wrote the report as markdown and burned an attempt.
          SUBMIT_REPORT_TOOL.schema.name,
        );
      } catch (err) {
        if (signal?.aborted) {
          log.info("run stopped by user while writing the report");
          persist();
          // The card is mid-spinner on their screen, and the turn it was
          // spinning for is gone. It ends offering the one thing left to do.
          publishReportCard(sessionId, "failed");
          return "stopped";
        }
        // The budget ran out with the record already complete. Ending without
        // the write-up is honest; pushing past the user's ceiling is not.
        if (outOfTime.aborted) {
          persist();
          return notWritten(
            "The time budget ran out before the report could be written.",
          );
        }
        throw err;
      }
      persist();
      if (signal?.aborted) {
        log.info("run stopped by user while writing the report");
        publishReportCard(sessionId, "failed");
        return "stopped";
      }

      /* Before the tool result: a reply cut off mid-call carries half-written
         arguments, so the refusal below would report a schema fault and hide the
         real cause. Neither is worth a second attempt - the ceiling stands. */
      if (written.stopReason === "max_tokens") {
        return notWritten(
          `The report was cut off at this model's output limit of ${llm.maxOutputTokens} tokens, so it was never finished. Raise the limit or pick a model with a larger one under Settings, Provider, then try again.`,
        );
      }
      if (written.stopReason === "refusal") {
        return notWritten("The model declined to write the report.");
      }

      const { toolResults } = await processToolUses({
        toolUses: written.toolUses,
        // The report turn offers one tool and no way to reach a human: the record
        // is already closed, so there is nothing left to ask about.
        offered: { tools: [SUBMIT_REPORT_TOOL], elicitations: [] },
        sessionId,
        execCtx: {
          sessionId,
          toolCallCeilingMs: config.toolCallCeilingMs,
        },
        log,
        alreadyRefused: refusedNames,
      });
      noteOutcomes(toolResults);
      if (toolResults.length > 0) provider.appendToolResults(toolResults);
      persist();

      problem = problemWithReport(getReport(sessionId)?.submitted ?? null);
      if (problem === null) {
        log.info({ turn, attempt }, "investigation report written");
        publishReportCard(sessionId, "ready");
        return "completed";
      }
      log.warn({ turn, attempt, problem }, "report turn refused");
    }
    return notWritten(
      `The model did not write the report after ${MAX_REPORT_ATTEMPTS} attempts. ${problem ?? ""}`.trim(),
    );
  };

  while (Date.now() < deadline) {
    turn++;

    // Re-read per turn, but never silently: a change the model is not told about
    // looks to it like the rules moved, and the prompt is never revised.
    const nowOffered = currentToolset(opensInvestigation);
    const change = toolsetChange(offered, nowOffered);
    if (change !== null) {
      log.info({ turn, change }, "offered toolset changed mid-run");
      offered = nowOffered;
      sendHarnessMessage(provider, change);
      persist();
    }
    const toolSchemas = offeredSchemas(offered);

    const startedAt = Date.now();
    let response: ChatResponse;
    try {
      response = await chatWithRetries(
        provider,
        toolSchemas,
        turnSeq(provider, seqOffset),
        runSignal,
      );
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
      // Push back up to MAX_NUDGES times, then write up from what there is - the
      // status an unfinished record derives to is already the honest one.
      const gaps = reportGaps(sessionId);
      // Read, not asked: the reconciler and the resolved webhook both stamp the
      // record, so the gate never makes a network call at the one instant a run
      // happens to end. That instant is almost never when a condition clears.
      const recovery = recoveryState(sessionId);
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
          "finish gate: request cap reached, writing up incomplete",
        );
      }
      /* Only a run that acted must recommend. "I could not work out the cause,
         here is what I ruled out" is a complete ending; a run that had the
         user release a write and then went quiet has left them nothing. */
      const released = gatedCalls(sessionId).some(
        (c) => c.decision === "approved",
      );
      return writeReport(released && recovery === "unconfirmed", turn);
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

    const { toolResults, gated, refused } = await processToolUses({
      toolUses: response.toolUses,
      offered,
      sessionId,
      execCtx,
      log,
      alreadyRefused: refusedNames,
    });
    for (const name of refused) {
      refusedNames.set(name, (refusedNames.get(name) ?? 0) + 1);
    }

    // A turn of nothing but unavailable tools got nothing done, and the model
    // cannot see it is looping. Only the time budget used to stop it.
    barrenTurns =
      refused.length === response.toolUses.length ? barrenTurns + 1 : 0;
    if (barrenTurns >= MAX_BARREN_TURNS) {
      log.warn(
        { turn, barrenTurns, refused: [...refusedNames.keys()] },
        "run asked only for unavailable tools; ending it",
      );
      provider.appendToolResults(toolResults);
      persist();
      appendErrorMessage(
        sessionId,
        `The last ${barrenTurns} turns asked only for tools this investigation does not have, so the run was ended rather than spend its budget repeating them. What was available: ${offeredSchemas(
          offered,
        )
          .map((t) => t.name)
          .join(", ")}.`,
      );
      return "completed";
    }

    noteOutcomes(toolResults);

    // A turn's tools outlive the stop that arrives during them, so the gate is
    // reached already aborted; suspending here parks an interrupt on a dead run.
    if (signal?.aborted) {
      log.info({ turn }, "run stopped by user before the gate");
      persist();
      return "stopped";
    }

    if (gated !== null) {
      // Durably suspend: persist assistant turn + interrupt row in one transaction, then exit and
      // free the slot. Suspended sessions take no injections, so the inbox isn't drained here.
      const isAskGate = gated.kind === "clarification";
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
        seenOutcomes,
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
          state: {
            phase: "awaiting_human",
            gate: isAskGate ? "clarification" : "approval",
          },
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
    // Already durable: the dispatcher wrote each one when it arrived. The inbox
    // exists to tell the model, which is a separate concern from keeping it.
    const injected = dispatcher.drainInbox(sessionId);
    if (injected.length > 0) {
      sendHarnessMessage(provider, formatInjectedAlerts(injected));
    }

    /* Counted over calls that answered: a refused call taught the run nothing,
       so it is no evidence the run should have settled something by now. After
       the results are on the provider, for the reason the drain above is - a
       harness turn wedged between a tool_use and its result orphans the pair. */
    answeredCalls += toolResults.filter(
      (result) => result.toolOutcome === undefined,
    ).length;
    if (
      opensInvestigation &&
      !recordChecked &&
      answeredCalls >= CALLS_BEFORE_RECORD_CHECK &&
      (getReport(sessionId)?.hypotheses ?? []).length === 0
    ) {
      recordChecked = true;
      log.info({ turn, answeredCalls }, "record still empty; asking about it");
      sendHarnessMessage(provider, recordCheck(answeredCalls));
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
    seenOutcomes,
    continueInterrupt,
  );
  publishTranscriptItem({
    sessionId,
    item: continueCard(continueId, { phase: "awaiting_human" }),
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

/* Its own turn, so it opens rather than continues: no leading blank lines.
   Stated, never asked - the alert source already grouped it, and asking the model
   to re-decide would hand a routing call to the thing being routed. */
function formatInjectedAlerts(alerts: NormalizedAlert[]): string {
  const header =
    alerts.length === 1
      ? "Another alert in this same alert group has fired while you were working. It is part of the incident you are investigating. Take it into account."
      : `${alerts.length} further alerts in this same alert group have fired while you were working. They are part of the incident you are investigating. Take them into account.`;
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
