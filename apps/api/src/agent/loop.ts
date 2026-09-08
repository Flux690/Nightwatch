import { randomUUID } from "node:crypto";
import { buildInitialContext, buildChatContext } from "./context.js";
import type { PromptOptions } from "./prompts/system.js";
import {
  RECORD_CHECK_OPENING,
  RECORD_GAPS_OPENING,
  recordGapsMessage,
  recordCheck,
  reportRequest,
  reportRetry,
} from "./prompts/report.js";
import {
  approvedWriteCount,
  gatedCalls,
  isCitable,
  recordGaps,
  reportIsBehind,
  toolCallsIn,
  type RecordGap,
} from "./report.js";
import { highestEvidenceNumber, resultParts } from "./evidence-id.js";
import { asSystemReminder, stripSystemReminder } from "./system-reminder.js";
import { SUBMIT_REPORT_TOOL } from "./tools/report.js";
import { getRecord } from "../session/record-store.js";
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
import { connectedKinds, getGitHubIntegration } from "../integrations/store.js";
import { getSession } from "../session/store.js";
import { toProviderMessage } from "../session/seed.js";
import {
  appendErrorMessage,
  appendRowsAndPark,
  appendTranscriptRows,
  getNextSeq,
  getTranscriptRows,
} from "../session/transcript-store.js";
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
import { getFleetView } from "../fleet/connections.js";
import { logger } from "../logger.js";
import { messagePartsToText, METRICS_SOURCE_KINDS } from "@nightwarden/shared";
import type {
  AlertGroupContext,
  GatedCall,
  MessagePart,
  NormalizedAlert,
  ToolName,
  TranscriptRow,
  SessionMeta,
} from "@nightwarden/shared";
import type {
  ChatResponse,
  LLMProvider,
  ProviderMessage,
  StopReason,
  ToolResult,
  ToolSchema,
  ToolUse,
} from "../llm/types.js";
import type { PendingHumanInput } from "../session/gate-store.js";

// What the fleet and the connected integrations currently allow. Read together,
// because the prompt describing them is built from the same call.
async function currentToolset(investigation: boolean): Promise<OfferedToolset> {
  const kinds = await connectedKinds();
  return effectiveToolset(
    connectedPlatforms(),
    {
      github: kinds.has("github"),
      metrics: METRICS_SOURCE_KINDS.some((k) => kinds.has(k)),
      loki: kinds.has("loki"),
      sentry: kinds.has("sentry"),
    },
    investigation,
  );
}

// Names only the difference: a run thirty turns deep does not need its whole
// toolset restated, and each tool already carries its own description.
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

/* A placeholder either way: the title model replaces it seconds later. Shared
   with the chat route, which writes the row before handing out its id. */
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

// A thrown error is the fourth state, "failed", and the dispatcher's catch
// owns it: it is never returned here.
export type RunOutcome = "completed" | "suspended" | "stopped";

// Finish-gate pushback cap: after this many the run writes up anyway rather
// than looping; the time budget bounds it as well.
const MAX_FINISH_PUSHBACKS = 5;

// Null once the cap is spent, which writes the report up incomplete.
type FinishGate = (gaps: RecordGap[]) => {
  say: string;
  pushbacks: number;
  repeated: RecordGap["kind"][];
} | null;

function finishGatePolicy(spent: number): FinishGate {
  let pushbacks = spent;
  const seen = new Map<RecordGap["kind"], number>();
  return (gaps) => {
    if (pushbacks >= MAX_FINISH_PUSHBACKS) return null;
    pushbacks++;
    const repeated = gaps.flatMap((gap) => {
      const times = (seen.get(gap.kind) ?? 0) + 1;
      seen.set(gap.kind, times);
      return times > 1 ? [gap.kind] : [];
    });
    return { say: recordGapsMessage(gaps), pushbacks, repeated };
  };
}

// Consecutive turns that asked for nothing but unavailable tools. Three is
// enough to tell a wrong guess from a model with nothing left to try.
const MAX_BARREN_TURNS = 3;

// The toolset rides in because it changes mid-run and the ending names it.
type BarrenTurns = (
  asked: number,
  refused: number,
  offered: OfferedToolset,
) => string | null;

/* A turn of nothing but unavailable tools gets nothing done, and the model
   cannot see it is looping, so only the time budget would stop it. */
function barrenTurnPolicy(): BarrenTurns {
  let barren = 0;
  return (asked, refused, offered) => {
    barren = refused === asked ? barren + 1 : 0;
    if (barren < MAX_BARREN_TURNS) return null;
    return `The last ${barren} turns asked only for tools this investigation does not have, so the run was ended rather than spend its budget repeating them. What was available: ${offeredSchemas(
      offered,
    )
      .map((t) => t.name)
      .join(", ")}.`;
  };
}

// Past orientation and long before the budget matters. A check, not a repair:
// nothing has failed, the run has simply read a lot and settled none of it.
const CALLS_BEFORE_RECORD_CHECK = 8;

// Every check is a durable row the seed replays, so a run that never records
// is bounded rather than asked for the rest of it.
const MAX_RECORD_CHECKS = 3;

interface RecordDebt {
  // What the finish gate asks the record to account for.
  unaccounted: () => number;
  // Takes the record's own claim count, so a claim recorded this turn clears
  // the debt before this turn's reads are counted against it.
  check: (claims: number, answered: number) => string | null;
}

/* Recording is what clears the debt, so a run that settles something early and
   then reads on is asked again. */
function recordDebtPolicy(investigation: boolean, spent: number): RecordDebt {
  let sinceClaim = 0;
  let claimsSeen = 0;
  // The debt when the check last spoke, so it asks again after another eight
  // rather than every turn.
  let checkedAt = 0;
  let checks = spent;
  return {
    unaccounted: () => sinceClaim,
    check: (claims, answered) => {
      if (claims > claimsSeen) {
        claimsSeen = claims;
        sinceClaim = 0;
        checkedAt = 0;
      }
      sinceClaim += answered;
      if (!investigation || checks >= MAX_RECORD_CHECKS) return null;
      if (sinceClaim - checkedAt < CALLS_BEFORE_RECORD_CHECK) return null;
      checks++;
      checkedAt = sinceClaim;
      return recordCheck(sinceClaim);
    },
  };
}

// What earlier runs on this session already spent, read off the turns they sent.
function spentOn(rows: readonly TranscriptRow[], opening: string): number {
  return rows.filter(
    (r) => r.kind === "system_reminder" && r.content.includes(opening),
  ).length;
}

// Read from the turn, because a harness turn orphans a tool_use from its result.
function citableIds(uses: readonly ToolUse[]): Set<string> {
  return new Set(
    uses.filter((t) => isCitable(t.name)).map((t) => t.toolCallId),
  );
}

// Calls that answered and could back a claim; a refused one taught nothing.
function citableAnswers(
  uses: readonly ToolUse[],
  results: readonly ToolResult[],
): number {
  const citable = citableIds(uses);
  return results.filter((r) => r.isError !== true && citable.has(r.toolCallId))
    .length;
}

// Matching the finish gate. The write-up is the deliverable, so an attempt
// costs far less than ending a run without one.
const MAX_REPORT_ATTEMPTS = 5;

/* Why a turn carries no usable answer, said in the transcript rather than only
   the log. Null where the turn is usable and the loop reads what it holds. */
function turnEnding(
  reason: StopReason,
  maxOutputTokens: number,
): string | null {
  switch (reason) {
    case "done":
    case "tools":
      return null;
    case "length":
      return `The model's reply was cut off at this model's output limit of ${maxOutputTokens} tokens, so this turn is incomplete. Send a message to continue, or pick a model with a larger limit in Settings.`;
    case "filtered":
      return "The model declined to continue this investigation. Nothing further was read, and anything already recorded stands.";
    case "error":
    case "unknown":
      return "The model provider ended this turn without an answer and without saying why, so nothing was added. Send a message to continue.";
  }
}

// The same question for the report turn, which has its own deliverable to name.
function reportEnding(
  reason: StopReason,
  maxOutputTokens: number,
): string | null {
  switch (reason) {
    case "done":
    case "tools":
      return null;
    case "length":
      return `The report was cut off at this model's output limit of ${maxOutputTokens} tokens, so it was never finished. Raise the limit or pick a model with a larger one under Settings, Provider, then try again.`;
    case "filtered":
      return "The model declined to write the report.";
    case "error":
    case "unknown":
      return "The model provider ended the report turn without an answer and without saying why.";
  }
}

/* Read from the tool's own answer: a follow-up run already holds a report, so
   the record's contents prove nothing about the turn that just ran. */
function reportRefusal(results: readonly ToolResult[]): string | null {
  // The turn offers one tool, so the first result is the submission or there is
  // none. The tool already told the model which field was wrong.
  const [submitted] = results;
  if (submitted === undefined) {
    return "The report turn ended without calling SubmitInvestigationReport.";
  }
  return submitted.isError === true ? "The report was refused." : null;
}

export interface RunSessionInput {
  sessionId: string;
  // As the sender grouped them, investigated as one incident with none elected.
  // Absent on a resume, which recovers them from the session row.
  alerts?: NormalizedAlert[];
  seed?: ProviderMessage[];
  userMessage?: string;
  // The user picked Investigate before they typed. An alert says the same
  // thing by existing; absent on a resume, which reads the session's own row.
  investigation?: boolean;
  // Stored as ours and never drawn: words the reader did not write must never
  // appear in their own voice.
  systemReminder?: string;
  // Aborts the LLM request in flight when the dispatcher stops this run.
  signal?: AbortSignal;
  // When true: seed prior transcript and run exactly one closing turn (no tools),
  // then finish. Used when the user declines a continue-request interrupt.
  standDown?: boolean;
  /* Alerts that arrived mid-run, handed in rather than fetched: the dispatcher
     owns the inbox and calls this, so the loop never imports it back. */
  drainInbox?: (sessionId: string) => NormalizedAlert[];
}

export async function runSession(input: RunSessionInput): Promise<RunOutcome> {
  const { sessionId, signal } = input;

  const stored = await getSession(sessionId);
  // A resume carries none, so the session's own record answers instead.
  const allAlerts =
    input.alerts ?? (stored?.alerts ?? []).map((entry) => entry.alert);
  const alert = allAlerts[0] ?? null;

  // An alert opens an investigation; otherwise the row answers, never an artifact
  // a previous run left behind. The row is a ratchet, so this only turns on.
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
  const readiness = await checkLLMReadiness();
  if (!readiness.ready) {
    throw new Error(notConfiguredMessage(readiness.missing));
  }
  // llm is the active provider's block flattened for the SDK; config carries the
  // loop and sandbox budgets, which are provider-independent.
  const { config: llm, apiKey } = readiness;
  const config = await loadConfig();

  // Transient provider errors are waited out instead of killing the run; each
  // wait is streamed to the frontend as live status.
  const chatWithRetries = async (
    provider: LLMProvider,
    messages: readonly ProviderMessage[],
    toolSchemas: ToolSchema[],
    turn: number,
    // The run's effective signal: the user's stop, or that combined with
    // the investigation deadline once the loop has one.
    chatSignal: AbortSignal | undefined = signal,
    forceTool?: ToolName,
  ): Promise<ChatResponse> =>
    await withLLMRetries(
      async () =>
        await provider.chat(
          messages,
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

  /* Every row this run produced, in order. The model reads all of them and the
     database is sent the tail past `flushed`, so the two cannot disagree. */
  const rows: TranscriptRow[] = [];
  let flushed = 0;
  let nextSeq = await getNextSeq(sessionId);
  // Carried for the run rather than recounted, so a long investigation does not
  // re-read its whole transcript to number one call.
  const priorRows = await getTranscriptRows(sessionId);
  let nextEvidence = highestEvidenceNumber(priorRows) + 1;

  const stage = (kind: TranscriptRow["kind"], parts: MessagePart[]): void => {
    rows.push({
      sessionId,
      seq: nextSeq++,
      kind,
      content: messagePartsToText(parts),
      parts,
      timestamp: new Date().toISOString(),
    });
  };

  // Read-only prefix already on disk, ahead of what this run appends.
  const seeded = input.seed ?? [];
  const conversation = (): ProviderMessage[] => [
    ...seeded,
    ...rows.map(toProviderMessage),
  ];

  const flush = async (interrupt?: PendingHumanInput): Promise<void> => {
    const unwritten = rows.slice(flushed);
    if (unwritten.length === 0 && interrupt === undefined) return;
    flushed = rows.length;
    if (interrupt) await appendRowsAndPark(unwritten, interrupt);
    else await appendTranscriptRows(unwritten);
    // A harness row draws nothing, so publishing it costs a refetch that
    // changes no pixel.
    for (const row of unwritten) {
      if (row.kind !== "system_reminder") publishMessage(sessionId, row);
    }
  };

  // The counter advances with the evidence rather than with the request, so a
  // call made in this reply has no handle until its answer arrives.
  const stageResults = (
    uses: readonly ToolUse[],
    results: readonly ToolResult[],
  ): void => {
    const stamped = resultParts(results, citableIds(uses), nextEvidence);
    nextEvidence = stamped.next;
    stage("user", stamped.parts);
  };

  // The one emitter of the marker, so also the door untrusted text arrives at:
  // an injected alert's labels are the sender's and must not close our tag.
  const sendSystemReminder = (text: string): void => {
    stage("system_reminder", [
      { type: "text", text: asSystemReminder(stripSystemReminder(text)) },
    ]);
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

    log.info("time budget ended: user chose to end, running closing turn");
    try {
      const closing = await chatWithRetries(
        provider,
        conversation(),
        [],
        nextSeq,
      );
      stage("assistant", closing.parts);
    } catch (err) {
      if (!signal?.aborted) throw err;
    }
    await flush();
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
      isChat: alert == null,
    },
    "investigation started",
  );

  const fleetView = getFleetView();
  const integration = await getGitHubIntegration();
  // Assembled once, before the prompt that describes it, so the prose and the
  // tools it describes are derived from one value and cannot disagree.
  let offered = await currentToolset(opensInvestigation);
  const promptOptions: PromptOptions = {
    budgetMinutes: Math.max(1, Math.round(config.checkInAfterMs / 60_000)),
    repo:
      integration === null
        ? null
        : `${integration.repoOwner}/${integration.repoName}`,
    fleetTools: connectedPlatforms().size > 0,
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

  if (seeded.length > 0) {
    // Written immediately so the frontend shows the turn the moment it is sent,
    // rather than waiting for the assistant's reply to flush both at once.
    if (input.userMessage) {
      const text = stripSystemReminder(input.userMessage);
      stage("user", [{ type: "text", text }]);
      await flush();
    } else if (input.systemReminder) {
      sendSystemReminder(input.systemReminder);
      await flush();
    }
  } else {
    // An alert has no human to type the first turn, so NightWarden writes it and
    // marks it as its own. A person's own first message is theirs.
    const own = input.userMessage === undefined && openingTurn !== null;
    const first = own
      ? asSystemReminder(openingTurn)
      : stripSystemReminder(input.userMessage ?? "");
    stage(own ? "system_reminder" : "user", [{ type: "text", text: first }]);
    await flush();
    // Brand-new session only: refine the title in the background. Chat uses the
    // message; an alert, a compact summary.
    const titleSource = input.userMessage ?? buildAlertTitleSource(allAlerts);
    void generateSessionTitle(sessionId, titleSource, llm, apiKey);
  }

  let turn = 0;
  // Per name across the whole run, so the fourth ask is answered as the fourth.
  const refusedNames = new Map<string, number>();
  /* The record belongs to the session, so its two allowances carry across a
     resume; a barren turn counts consecutive turns and starts afresh. */
  const finishGate = finishGatePolicy(spentOn(priorRows, RECORD_GAPS_OPENING));
  const barrenTurns = barrenTurnPolicy();
  const recordDebt = recordDebtPolicy(
    opensInvestigation,
    spentOn(priorRows, RECORD_CHECK_OPENING),
  );
  // Computed once and never moved, so a run cannot outrun its own clock: every
  // turn spends the same budget and the check-in below always arrives.
  const deadline = Date.now() + config.checkInAfterMs;
  // One shared instant rather than a duration each layer counts separately.
  // Distinct from `signal`, which means the user stopped the run.
  const outOfTime = AbortSignal.timeout(config.checkInAfterMs);
  const runSignal = signal ? AbortSignal.any([signal, outOfTime]) : outOfTime;

  // Every other tool taken away, and the claims ride the request: turn forty
  // is the worst place to copy a call id from.
  const writeReport = async (
    unrecovered: boolean,
    turn: number,
    // Handed over rather than read again: the report turn offers one ungated
    // tool, so nothing it does can change the list.
    gated: GatedCall[],
  ): Promise<RunOutcome> => {
    // Said out loud rather than only to the server log: an investigation with no
    // write-up looked exactly like one whose model chose not to write much.
    const notWritten = async (why: string): Promise<RunOutcome> => {
      log.warn({ turn }, "report turn failed; the record stands without one");
      await appendErrorMessage(
        sessionId,
        `${why} Your findings below are complete.`,
      );
      publishReportCard(sessionId, "failed");
      return "completed";
    };

    publishReportCard(sessionId, "building");
    let problem: string | null = null;
    for (let attempt = 1; attempt <= MAX_REPORT_ATTEMPTS; attempt++) {
      sendSystemReminder(
        problem === null
          ? reportRequest(
              (await getRecord(sessionId))?.hypotheses ?? [],
              gated,
              unrecovered,
              /* So a follow-up revises what a previous run wrote rather than
                 rebuilding it from a context that may since have been compacted. */
              (await getRecord(sessionId))?.report ?? null,
            )
          : reportRetry(problem),
      );
      await flush();

      let written: ChatResponse;
      try {
        written = await chatWithRetries(
          provider,
          conversation(),
          [SUBMIT_REPORT_TOOL.schema],
          nextSeq,
          runSignal,
          // One tool and one job, so the turn cannot come back as prose. It has:
          // a model once wrote the report as markdown and burned an attempt.
          SUBMIT_REPORT_TOOL.schema.name,
        );
        stage("assistant", written.parts);
      } catch (err) {
        if (signal?.aborted) {
          log.info("run stopped by user while writing the report");
          await flush();
          // The card is mid-spinner on their screen, and the turn it was
          // spinning for is gone. It ends offering the one thing left to do.
          publishReportCard(sessionId, "failed");
          return "stopped";
        }
        // The budget ran out with the record already complete. Ending without
        // the write-up is honest; pushing past the user's ceiling is not.
        if (outOfTime.aborted) {
          await flush();
          return await notWritten(
            "The time budget ran out before the report could be written.",
          );
        }
        throw err;
      }
      await flush();
      if (signal?.aborted) {
        log.info("run stopped by user while writing the report");
        publishReportCard(sessionId, "failed");
        return "stopped";
      }

      /* Read before the tool results: a reply cut off mid-call carries
         half-written arguments, which would refuse as a schema fault instead. */
      const ended = reportEnding(written.stopReason, llm.maxOutputTokens);
      if (ended !== null) return await notWritten(ended);

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
      if (toolResults.length > 0) {
        stageResults(written.toolUses, toolResults);
      }
      await flush();

      problem = reportRefusal(toolResults);
      if (problem === null) {
        log.info({ turn, attempt }, "investigation report written");
        publishReportCard(sessionId, "ready");
        return "completed";
      }
      log.warn({ turn, attempt, problem }, "report turn refused");
    }
    return await notWritten(
      `The model did not write the report after ${MAX_REPORT_ATTEMPTS} attempts. ${problem ?? ""}`.trim(),
    );
  };

  while (Date.now() < deadline) {
    turn++;

    // Re-read per turn, but never silently: a change the model is not told about
    // looks to it like the rules moved, and the prompt is never revised.
    const nowOffered = await currentToolset(opensInvestigation);
    const change = toolsetChange(offered, nowOffered);
    if (change !== null) {
      log.info({ turn, change }, "offered toolset changed mid-run");
      offered = nowOffered;
      sendSystemReminder(change);
      await flush();
    }
    const toolSchemas = offeredSchemas(offered);

    const startedAt = Date.now();
    let response: ChatResponse;
    try {
      response = await chatWithRetries(
        provider,
        conversation(),
        toolSchemas,
        nextSeq,
        runSignal,
      );
      stage("assistant", response.parts);
    } catch (err) {
      if (signal?.aborted) {
        log.info({ turn }, "run stopped by user");
        await flush();
        return "stopped";
      }
      // The budget cut the turn short. That is the check-in below, not a
      // failure, so it leaves the loop rather than killing the run.
      if (outOfTime.aborted) {
        log.info({ turn }, "time budget reached mid-turn");
        await flush();
        break;
      }
      throw err;
    }
    if (signal?.aborted) {
      log.info({ turn }, "run stopped by user");
      await flush();
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
    await flush();

    /* Without an error row the session derives to completed and a turn that
       answered nothing is invisible, so the ending is said in the transcript. */
    const ending = turnEnding(response.stopReason, llm.maxOutputTokens);
    if (ending !== null) {
      log.warn(
        { turn, model: llm.model, stopReason: response.stopReason },
        "turn ended without an answer",
      );
      await appendErrorMessage(sessionId, ending);
      return "completed";
    }

    if (response.toolUses.length === 0) {
      if (!opensInvestigation) {
        log.info({ turn }, "chat finished with free-form response");
        return "completed";
      }
      const gaps = await recordGaps(sessionId, recordDebt.unaccounted());
      // Read, not asked: the reconciler and the resolved webhook both stamp the
      // record, so the gate never makes a network call as a run happens to end.
      const recovery = await recoveryState(sessionId);
      if (gaps.length > 0) {
        const pushback = finishGate(gaps);
        if (pushback !== null) {
          // A gap that outlives its own pushback is a broken tool or a
          // description the model cannot act on, not a distracted model.
          if (pushback.repeated.length > 0) {
            log.warn(
              { turn, gaps: pushback.repeated },
              "finish gate: a gap survived a pushback",
            );
          }
          log.info(
            {
              turn,
              pushbacks: pushback.pushbacks,
              gaps: gaps.map((g) => g.kind),
              recovery,
            },
            "finish gate: record incomplete, pushing back",
          );
          sendSystemReminder(pushback.say);
          await flush();
          continue;
        }
        log.warn(
          { turn, gaps: gaps.map((g) => g.kind), recovery },
          "finish gate: request cap reached, writing up incomplete",
        );
      }
      // Only a run that acted must recommend: ruling things out is a complete
      // ending, but releasing a write and going quiet leaves the user nothing.
      const gated = gatedCalls(await toolCallsIn(sessionId));
      const approvedWrites = approvedWriteCount(gated);
      /* Rewriting is lossy, so a write-up that still covers the record is kept.
         Recovery is not a reason: a cleared alert already reads as Resolved. */
      const record = await getRecord(sessionId);
      if (record !== undefined && !reportIsBehind(record, approvedWrites)) {
        log.info({ turn }, "write-up still covers the record; keeping it");
        return "completed";
      }
      return await writeReport(
        approvedWrites > 0 && recovery === "unconfirmed",
        turn,
        gated,
      );
    }

    const execCtx: Omit<ToolDispatchContext, "toolCallId"> = {
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

    const barren = barrenTurns(
      response.toolUses.length,
      refused.length,
      offered,
    );
    if (barren !== null) {
      log.warn(
        { turn, refused: [...refusedNames.keys()] },
        "run asked only for unavailable tools; ending it",
      );
      stageResults(response.toolUses, toolResults);
      await flush();
      await appendErrorMessage(sessionId, barren);
      return "completed";
    }

    // A turn's tools outlive the stop that arrives during them, so the gate is
    // reached already aborted; suspending here parks an interrupt on a dead run.
    if (signal?.aborted) {
      log.info({ turn }, "run stopped by user before the gate");
      await flush();
      return "stopped";
    }

    if (gated !== null) {
      // Durably suspend: persist assistant turn + interrupt row in one transaction, then exit and
      // free the slot. Suspended sessions take no injections, so the inbox isn't drained here.
      const isAskGate = gated.kind === "clarification";
      const interrupt: PendingHumanInput = {
        sessionId,
        toolCallId: gated.tool.toolCallId,
        kind: isAskGate ? "clarification" : "approval",
        completedResults: toolResults,
        claimedAt: null,
      };
      await flush(interrupt);
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
          toolCallId: gated.tool.toolCallId,
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
        toolCallId: gated.tool.toolCallId,
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

    // Drained at the tool boundary, the earliest point the model can act on one,
    // as their own turn after the results.
    stageResults(response.toolUses, toolResults);
    // Already durable: the dispatcher wrote each one when it arrived. The inbox
    // exists to tell the model, which is a separate concern from keeping it.
    const injected = input.drainInbox?.(sessionId) ?? [];
    if (injected.length > 0) {
      sendSystemReminder(formatInjectedAlerts(injected));
    }

    const claims = ((await getRecord(sessionId))?.hypotheses ?? []).length;
    const ask = recordDebt.check(
      claims,
      citableAnswers(response.toolUses, toolResults),
    );
    if (ask !== null) {
      log.info(
        { turn, unaccounted: recordDebt.unaccounted() },
        "reads unaccounted for; asking",
      );
      sendSystemReminder(ask);
    }
    await flush();
  }

  // No underlying tool call, so the synthetic toolCallId only keys the
  // interrupt row - the resolver branches on kind, not the transcript.
  const continueId = randomUUID();
  const continueInterrupt: PendingHumanInput = {
    sessionId,
    toolCallId: continueId,
    kind: "continue",
    completedResults: [],
    claimedAt: null,
  };
  await flush(continueInterrupt);
  publishTranscriptItem({
    sessionId,
    item: continueCard(continueId, { phase: "awaiting_human" }),
  });
  publishInterrupt({
    sessionId,
    toolCallId: continueId,
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

// Stated, never asked: the alert source already grouped it, and asking the
// model would hand a routing call to the thing being routed.
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
          `- [${a.alertType}] ${formatLabels(a.labels)} (${a.labels["severity"] ?? "no severity"}) fired at ${a.firedAt} [id: ${a.sourceAlertId}]`,
      )
      .join("\n")
  );
}
