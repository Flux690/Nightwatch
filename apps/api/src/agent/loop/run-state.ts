import {
  messagePartsToText,
  type MessagePart,
  type NormalizedAlert,
  type ResolvedLLMConfig,
  type ToolName,
  type TranscriptRow,
} from "@nightwarden/shared";
import { resultParts } from "../evidence-id.js";
import { asSystemReminder, stripSystemReminder } from "../system-reminder.js";
import type { OfferedToolset } from "../tools/toolset.js";
import { toProviderMessage } from "../../session/seed.js";
import {
  appendRowsAndPark,
  appendTranscriptRows,
} from "../../session/transcript-store.js";
import { publishMessage } from "../../session/stream.js";
import type { PendingHumanInput } from "../../session/gate-store.js";
import { logger } from "../../logger.js";
import type {
  ChatResponse,
  ProviderMessage,
  ToolResult,
  ToolSchema,
  ToolUse,
} from "../../llm/types.js";
import { citableIds } from "./guardrails.js";
import type { BarrenTurns, FinishGate, RecordDebt } from "./guardrails.js";

// A thrown error is the fourth state, "failed", and the dispatcher's catch
// owns it: it is never returned here.
export type RunOutcome = "completed" | "suspended" | "stopped";

// One chat call with the run's provider bound in: the driver supplies it so the
// turn cycle never sees the provider or the retry policy.
export type ChatFn = (
  messages: readonly ProviderMessage[],
  tools: ToolSchema[],
  turn: number,
  signal?: AbortSignal,
  forceTool?: ToolName,
) => Promise<ChatResponse>;

/* The transcript this run is building, and the five operations over it. The
   rows are kept in memory and the tail past `flushed` is what reaches disk. */
export class RunState {
  readonly rows: TranscriptRow[] = [];
  private flushed = 0;
  nextSeq: number;
  nextEvidence: number;
  // Set before the first turn and re-read each turn as integrations connect.
  offered!: OfferedToolset;
  turn = 0;
  // A citable call has answered, so candidates can be opened against real
  // evidence rather than before any was gathered.
  hasAnsweredCitable = false;
  // OpenCandidates has run, so the forced candidates turn does not fire again.
  candidatesOpened = false;
  // The falsification turn has run, so the run composes its report next.
  falsificationOffered = false;
  // Per name across the whole run, so the fourth ask is answered as the fourth.
  readonly refusedNames = new Map<string, number>();

  constructor(
    readonly sessionId: string,
    nextSeq: number,
    nextEvidence: number,
    // Read-only prefix already on disk, ahead of what this run appends.
    private readonly seeded: readonly ProviderMessage[],
  ) {
    this.nextSeq = nextSeq;
    this.nextEvidence = nextEvidence;
  }

  stage(kind: TranscriptRow["kind"], parts: MessagePart[]): void {
    this.rows.push({
      sessionId: this.sessionId,
      seq: this.nextSeq++,
      kind,
      content: messagePartsToText(parts),
      parts,
      timestamp: new Date().toISOString(),
    });
  }

  conversation(): ProviderMessage[] {
    return [...this.seeded, ...this.rows.map(toProviderMessage)];
  }

  async flush(interrupt?: PendingHumanInput): Promise<void> {
    const unwritten = this.rows.slice(this.flushed);
    if (unwritten.length === 0 && interrupt === undefined) return;
    this.flushed = this.rows.length;
    if (interrupt) await appendRowsAndPark(unwritten, interrupt);
    else await appendTranscriptRows(unwritten);
    // A harness row draws nothing, so publishing it costs a refetch that
    // changes no pixel.
    for (const row of unwritten) {
      if (row.kind !== "system_reminder") publishMessage(this.sessionId, row);
    }
  }

  // The counter advances with the evidence rather than with the request, so a
  // call made in this reply has no handle until its answer arrives.
  stageResults(uses: readonly ToolUse[], results: readonly ToolResult[]): void {
    const stamped = resultParts(results, citableIds(uses), this.nextEvidence);
    if (stamped.next > this.nextEvidence) this.hasAnsweredCitable = true;
    this.nextEvidence = stamped.next;
    this.stage("user", stamped.parts);
  }

  // The one emitter of the marker, so also the door untrusted text arrives at:
  // an injected alert's labels are the sender's and must not close our tag.
  sendSystemReminder(text: string): void {
    this.stage("system_reminder", [
      { type: "text", text: asSystemReminder(stripSystemReminder(text)) },
    ]);
  }
}

// What the driver hands the turn cycle: the run's fixed facts, the bound chat
// call, and the three guardrail policies. The state above carries the rest.
export interface RunContext {
  readonly state: RunState;
  readonly sessionId: string;
  // The user's stop.
  readonly signal: AbortSignal | undefined;
  // The user's stop combined with the investigation deadline.
  readonly runSignal: AbortSignal;
  readonly outOfTime: AbortSignal;
  readonly deadline: number;
  readonly log: typeof logger;
  readonly opensInvestigation: boolean;
  readonly llm: ResolvedLLMConfig;
  readonly toolCallCeilingMs: number;
  readonly chat: ChatFn;
  readonly finishGate: FinishGate;
  readonly barrenTurns: BarrenTurns;
  readonly recordDebt: RecordDebt;
  readonly drainInbox?: (sessionId: string) => NormalizedAlert[];
}

/* What one turn tells the driver to do next: loop again, break to the
   continue-request, or end the run with this outcome. */
export type TurnResult =
  | { kind: "continue" }
  | { kind: "budget" }
  | { kind: "outcome"; outcome: RunOutcome };
