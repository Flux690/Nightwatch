import { randomUUID } from "node:crypto";
import { buildInitialContext, buildChatContext } from "../context.js";
import type { PromptOptions } from "../prompts/system.js";
import {
  RECORD_CHECK_OPENING,
  RECORD_GAPS_OPENING,
} from "../prompts/report.js";
import { highestEvidenceNumber } from "../evidence-id.js";
import { asSystemReminder, stripSystemReminder } from "../system-reminder.js";
import { connectedPlatforms } from "../policy.js";
import { retrySummary, withLLMRetries } from "../../llm/failures.js";
import { retryDelaysMs } from "../../llm/config.js";
import { createProvider } from "../../llm/factory.js";
import {
  checkLLMReadiness,
  notConfiguredMessage,
} from "../../config/readiness.js";
import { loadConfig } from "../../config/store.js";
import { getGitHubIntegration } from "../../integrations/store.js";
import { getSession } from "../../session/store.js";
import {
  getNextSeq,
  getTranscriptRows,
} from "../../session/transcript-store.js";
import {
  publishTextMessageContent,
  publishInterrupt,
  publishRunRetrying,
  publishTranscriptItem,
} from "../../session/stream.js";
import { continueCard } from "../../session/transcript.js";
import {
  generateSessionTitle,
  buildAlertTitleSource,
} from "../../session/title.js";
import { getFleetView } from "../../fleet/connections.js";
import { logger } from "../../logger.js";
import type {
  AlertGroupContext,
  NormalizedAlert,
  ToolName,
  SessionMeta,
} from "@nightwarden/shared";
import type {
  ChatResponse,
  LLMProvider,
  ProviderMessage,
  ToolSchema,
} from "../../llm/types.js";
import type { PendingHumanInput } from "../../session/gate-store.js";
import {
  barrenTurnPolicy,
  finishGatePolicy,
  recordDebtPolicy,
  spentOn,
} from "./guardrails.js";
import { RunState } from "./run-state.js";
import type { RunContext, RunOutcome } from "./run-state.js";
import { currentToolset, runOneTurn } from "./run-turn.js";

export type { RunOutcome };

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

// The driver: it sets the run up, then loops runOneTurn until a turn ends the
// run or the time budget runs out and it parks a continue-request.
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

  // Carried for the run rather than recounted, so a long investigation does not
  // re-read its whole transcript to number one call.
  const priorRows = await getTranscriptRows(sessionId);
  const seeded = input.seed ?? [];
  const state = new RunState(
    sessionId,
    await getNextSeq(sessionId),
    highestEvidenceNumber(priorRows) + 1,
    seeded,
  );

  // User declined a continue-request: replay the transcript and run one
  // free-form closing turn with no tools, then finish.
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
        state.conversation(),
        [],
        state.nextSeq,
      );
      state.stage("assistant", closing.parts);
    } catch (err) {
      if (!signal?.aborted) throw err;
    }
    await state.flush();
    if (signal?.aborted) {
      log.info("run stopped by user during the closing turn");
      return "stopped";
    }
    log.info("investigation ended after user declined to continue");
    return "completed";
  }

  log.info(
    { alertLabels: alert?.labels ?? null, isChat: alert == null },
    "investigation started",
  );

  const fleetView = getFleetView();
  const integration = await getGitHubIntegration();
  // Assembled once, before the prompt that describes it, so the prose and the
  // tools it describes are derived from one value and cannot disagree.
  state.offered = await currentToolset(opensInvestigation);
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
      state.stage("user", [
        { type: "text", text: stripSystemReminder(input.userMessage) },
      ]);
      await state.flush();
    } else if (input.systemReminder) {
      state.sendSystemReminder(input.systemReminder);
      await state.flush();
    }
  } else {
    // An alert has no human to type the first turn, so NightWarden writes it and
    // marks it as its own. A person's own first message is theirs.
    const own = input.userMessage === undefined && openingTurn !== null;
    const first = own
      ? asSystemReminder(openingTurn)
      : stripSystemReminder(input.userMessage ?? "");
    state.stage(own ? "system_reminder" : "user", [
      { type: "text", text: first },
    ]);
    await state.flush();
    // Brand-new session only: refine the title in the background. Chat uses the
    // message; an alert, a compact summary.
    const titleSource = input.userMessage ?? buildAlertTitleSource(allAlerts);
    void generateSessionTitle(sessionId, titleSource, llm, apiKey);
  }

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

  const ctx: RunContext = {
    state,
    sessionId,
    signal,
    runSignal,
    outOfTime,
    deadline,
    log,
    opensInvestigation,
    llm,
    toolCallCeilingMs: config.toolCallCeilingMs,
    // The provider is bound in here, so the turn cycle never sees it.
    chat: (messages, tools, turn, chatSignal, forceTool) =>
      chatWithRetries(provider, messages, tools, turn, chatSignal, forceTool),
    finishGate,
    barrenTurns,
    recordDebt,
    drainInbox: input.drainInbox,
  };

  while (Date.now() < deadline) {
    const result = await runOneTurn(ctx);
    if (result.kind === "outcome") return result.outcome;
    if (result.kind === "budget") break;
  }

  // No underlying tool call, so the synthetic toolCallId only keys the interrupt
  // row - the resolver branches on kind, not the transcript.
  const continueId = randomUUID();
  const continueInterrupt: PendingHumanInput = {
    sessionId,
    toolCallId: continueId,
    kind: "continue",
    completedResults: [],
    claimedAt: null,
  };
  await state.flush(continueInterrupt);
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
  log.info(
    { turn: state.turn },
    "time budget reached: suspended with continue request",
  );
  return "suspended";
}
