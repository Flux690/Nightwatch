import type { GatedCall, ReportCardItem } from "@nightwarden/shared";
import { reportRequest, reportRetry } from "../prompts/report.js";
import { SUBMIT_REPORT_TOOL } from "../tools/report.js";
import { getRecord } from "../../session/record-store.js";
import { appendErrorMessage } from "../../session/transcript-store.js";
import { publishTranscriptItem } from "../../session/stream.js";
import type { ChatResponse } from "../../llm/types.js";
import { processToolUses } from "./turn.js";
import { reportEnding, reportRefusal } from "./endings.js";
import type { RunContext, RunOutcome } from "./run-state.js";

// Matching the finish gate. The write-up is the deliverable, so an attempt
// costs far less than ending a run without one.
const MAX_REPORT_ATTEMPTS = 5;

// One id, because a session has one report: a later phase replaces the card
// rather than stacking a second one under the first.
export function publishReportCard(
  sessionId: string,
  phase: ReportCardItem["state"]["phase"],
): void {
  publishTranscriptItem({
    sessionId,
    item: { kind: "report_card", id: "report", state: { phase } },
  });
}

/* The final turn of an investigation: every other tool is taken away and the
   claims ride the request, so a timeline copies call ids from nearby. */
export async function writeReport(
  ctx: RunContext,
  unrecovered: boolean,
  // Handed over rather than read again: the report turn offers one ungated
  // tool, so nothing it does can change the list.
  gated: GatedCall[],
): Promise<RunOutcome> {
  const { state, sessionId, log, llm } = ctx;
  const turn = state.turn;

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
    state.sendSystemReminder(
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
    await state.flush();

    let written: ChatResponse;
    try {
      written = await ctx.chat(
        state.conversation(),
        [SUBMIT_REPORT_TOOL.schema],
        state.nextSeq,
        ctx.runSignal,
        // One tool and one job, so the turn cannot come back as prose. It has:
        // a model once wrote the report as markdown and burned an attempt.
        SUBMIT_REPORT_TOOL.schema.name,
      );
      state.stage("assistant", written.parts);
    } catch (err) {
      if (ctx.signal?.aborted) {
        log.info("run stopped by user while writing the report");
        await state.flush();
        // The card is mid-spinner on their screen, and the turn it was
        // spinning for is gone. It ends offering the one thing left to do.
        publishReportCard(sessionId, "failed");
        return "stopped";
      }
      // The budget ran out with the record already complete. Ending without
      // the write-up is honest; pushing past the user's ceiling is not.
      if (ctx.outOfTime.aborted) {
        await state.flush();
        return await notWritten(
          "The time budget ran out before the report could be written.",
        );
      }
      throw err;
    }
    await state.flush();
    if (ctx.signal?.aborted) {
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
      execCtx: { sessionId, toolCallCeilingMs: ctx.toolCallCeilingMs },
      log,
      alreadyRefused: state.refusedNames,
    });
    if (toolResults.length > 0) {
      state.stageResults(written.toolUses, toolResults);
    }
    await state.flush();

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
}
