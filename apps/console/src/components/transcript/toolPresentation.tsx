import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { ICON_INLINE } from "@/lib/iconProps";
import { Button } from "@/components/ui/button";
import { onRevealToolCall, REVEAL_MS } from "./revealToolCall.js";
import { cn } from "@/lib/utils";
import { isTool } from "@nightwarden/shared";
import type { ToolName } from "@nightwarden/shared";
import { asRecord, stringAt as inputString } from "@/lib/toolResult";
import type {
  HumanDecision,
  ToolCallItem,
  ToolCallState,
  ToolOutcome,
} from "./types.js";
import { DiffCard, parseFileChange } from "./DiffCard.js";
import { PRCard, parsePullRequestResult } from "./PRCard.js";
import { clipLine, findingFor, formatBytes } from "./toolFindings.js";

/* One row shape for every tool: name, target, the finding, and a chevron. The
   row carries the answer so the common case needs no click, and expansion is a
   thread line: at rail width a box per tool buries the conversation. */

// Beyond this the body scrolls behind an explicit opt-in. The runner already
// caps its output at 64KB for safety; this is the separate, much tighter cap
// for something a person is meant to read.
const BODY_MAX_LINES = 8;

// Shared with the approval card, which labels the same three as one action.
export const SHELL_TOOLS: readonly ToolName[] = [
  "DockerBash",
  "K8sBash",
  "Bash",
];

// Fleet tools address a service by target key; host tools name a server. Shared
// with the report, so a cited call names its target the same way there.
export function targetOf(input: Record<string, unknown>): string | null {
  const target = input["target"];
  if (typeof target === "string") {
    const parts = target.split("/");
    return parts[parts.length - 1] ?? target;
  }
  return inputString(input, "server");
}

function outcomeOf(state: ToolCallState): ToolOutcome | undefined {
  return state.phase === "complete" || state.phase === "resolved"
    ? state.outcome
    : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

const MONO = "font-mono text-sm leading-relaxed";

/* What a non-success reads as. The word carries the distinction and the colour
   only reinforces it, so a permission failure and a crash never look alike. A
   miss is deliberately unlabelled and unmuted-red: the tool worked. */
const OUTCOME_LABEL: Record<ToolOutcome, string> = {
  partial: "Some runners failed",
  expected_miss: "",
  retryable: "Unavailable",
  permission: "Permission denied",
  system: "Failed",
};

const OUTCOME_TONE: Record<ToolOutcome, string> = {
  partial: "text-wait",
  expected_miss: "text-muted-foreground",
  retryable: "text-wait",
  permission: "text-wait",
  system: "text-fail",
};

/* A decision, not a fault: nothing broke and nothing ran. It reads off what the
   person said rather than off a tool outcome, because a declined call has none -
   the tool it names never executed. */
const DECLINED = { text: "Declined", tone: "text-muted-foreground" } as const;

// The one-line reading of a settled call, shared with the report so a cited
// result reads the same in both. The class outranks the finding's own tone: a
// result that never arrived has nothing to read off.
export function resultSummary(
  toolName: string,
  result: unknown,
  outcome: ToolOutcome | undefined,
  humanDecision?: HumanDecision,
): { text: string; tone: string } {
  if (humanDecision === "rejected") return { ...DECLINED };
  const finding = findingFor(toolName, result);
  const tone =
    outcome !== undefined
      ? OUTCOME_TONE[outcome]
      : finding?.tone === "bad"
        ? "text-fail"
        : "text-muted-foreground";
  const label = outcome === undefined ? "" : OUTCOME_LABEL[outcome];
  return { text: [label, finding?.text].filter(Boolean).join(" · "), tone };
}

// Capped text with an explicit, counted opt-in. "Show all" reveals exactly what
// the runner returned, already redacted and already size-capped upstream.
function CappedText({ text }: { text: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const lines = text.split("\n");
  const hidden = lines.length - BODY_MAX_LINES;

  if (hidden <= 0)
    return (
      <pre className={cn(MONO, "m-0 whitespace-pre-wrap break-words")}>
        {text}
      </pre>
    );

  return (
    <div>
      <pre
        className={cn(
          MONO,
          "m-0 whitespace-pre-wrap break-words",
          open && "max-h-72 overflow-auto",
        )}
      >
        {open ? text : lines.slice(0, BODY_MAX_LINES).join("\n")}
      </pre>
      <Button variant="link" className="mt-2" onClick={() => setOpen(!open)}>
        {open ? "Show less" : `Show all ${lines.length} lines`}
      </Button>
    </div>
  );
}

function LogLines({ lines }: { lines: string[] }): React.JSX.Element {
  return <CappedText text={lines.join("\n")} />;
}

function KeyValues({
  rows,
}: {
  rows: [string, string][];
}): React.JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <dl className="m-0 flex flex-col gap-1">
      {rows.map(([label, value]) => (
        <div key={label} className="flex gap-3">
          <dt className="w-32 shrink-0 text-sm text-ink-subtle">{label}</dt>
          <dd className={cn(MONO, "m-0 min-w-0 break-words tabular-nums")}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function EventList({
  events,
}: {
  events: Record<string, unknown>[];
}): React.JSX.Element {
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {events.slice(0, BODY_MAX_LINES).map((event, i) => {
        const at =
          typeof event["timestamp"] === "string" ? event["timestamp"] : "";
        const label =
          typeof event["eventType"] === "string" ? event["eventType"] : "";
        return (
          <li key={`${at}-${i}`} className={cn(MONO, "flex gap-3")}>
            <time className="shrink-0 text-ink-subtle">
              {at ? new Date(at).toLocaleTimeString() : ""}
            </time>
            <span className="min-w-0 break-words text-muted-foreground">
              {label}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// Per-tool bodies. A tool with no entry falls back to its raw result, which is
// honest: better a JSON block than a shape we pretended to understand. The
// report quotes a cited call through this too, so one result renders one way.
function ToolBody({
  toolName,
  input,
  result,
}: {
  toolName: string;
  input: Record<string, unknown>;
  result: unknown;
}): React.JSX.Element {
  // Before the record guard: an answer is a bare string, so asRecord would send
  // it to the raw fallback and print the question nowhere.
  if (isTool(toolName, "AskUserQuestion")) {
    const answer = typeof result === "string" ? result : JSON.stringify(result);
    return (
      <dl className="m-0 flex flex-col gap-2">
        {[
          ["Asked", inputString(input, "question") ?? ""],
          ["You", answer],
        ].map(([label, value]) => (
          <div key={label} className="flex gap-3">
            <dt className="w-16 shrink-0 text-sm text-ink-subtle">{label}</dt>
            <dd className="m-0 min-w-0 text-sm break-words whitespace-pre-wrap">
              {value}
            </dd>
          </div>
        ))}
      </dl>
    );
  }

  const record = asRecord(result);

  if (record !== null) {
    if (isTool(toolName, "GetDockerLogs", "GetK8sLogs")) {
      return <LogLines lines={stringList(record["lines"])} />;
    }

    if (isTool(toolName, "GetDockerEvents", "GetK8sEvents")) {
      const events = Array.isArray(record["events"])
        ? (record["events"] as Record<string, unknown>[])
        : [];
      return <EventList events={events} />;
    }

    if (isTool(toolName, "GetDockerStats", "GetK8sStats")) {
      const rows: [string, string][] = [];
      const cpu = record["cpuPercent"];
      const used = record["memoryUsedBytes"];
      const limit = record["memoryLimitBytes"];
      const pids = record["pids"];
      if (typeof cpu === "number") rows.push(["cpu", `${cpu.toFixed(2)}%`]);
      if (typeof used === "number") rows.push(["memory", formatBytes(used)]);
      if (typeof limit === "number") rows.push(["limit", formatBytes(limit)]);
      if (typeof pids === "number") rows.push(["processes", String(pids)]);
      return <KeyValues rows={rows} />;
    }

    if (isTool(toolName, "GetHostMemory")) {
      const rows: [string, string][] = [];
      const total = record["totalBytes"];
      const available = record["availableBytes"];
      const swap = record["swapUsedBytes"];
      if (typeof available === "number")
        rows.push(["available", formatBytes(available)]);
      if (typeof total === "number") rows.push(["total", formatBytes(total)]);
      if (typeof swap === "number") rows.push(["swap used", formatBytes(swap)]);
      rows.push([
        "oom killer",
        record["oomKillerFiredRecently"] === true ? "fired recently" : "quiet",
      ]);
      return <KeyValues rows={rows} />;
    }

    if (isTool(toolName, "GetDockerConfig", "GetK8sConfig")) {
      const rows: [string, string][] = [];
      for (const key of ["name", "image", "restartPolicy"]) {
        const value = record[key];
        if (typeof value === "string") rows.push([key, value]);
      }
      const ports = stringList(record["ports"]);
      if (ports.length > 0) rows.push(["ports", ports.join(", ")]);
      return <KeyValues rows={rows} />;
    }

    // Shell tools: the command, then its output. Keyed on the tool name, not on the
    // presence of an exitCode - plenty of results carry one without being a shell
    // command, and deserve their own shape rather than an empty terminal.
    if (isTool(toolName, ...SHELL_TOOLS)) {
      const argv = Array.isArray(input["command"])
        ? (input["command"] as unknown[]).map(String).join(" ")
        : (inputString(input, "command") ?? "");
      // Split streams from the runner, one combined `output` from the sandbox.
      const stdout =
        typeof record["stdout"] === "string"
          ? record["stdout"]
          : typeof record["output"] === "string"
            ? record["output"]
            : "";
      const stderr =
        typeof record["stderr"] === "string" ? record["stderr"] : "";
      const body = [stdout, stderr]
        .filter((s) => s.trim().length > 0)
        .join("\n");
      return (
        <div className="flex flex-col gap-2">
          {argv && (
            <pre className={cn(MONO, "m-0 whitespace-pre-wrap break-words")}>
              <span className="text-ink-subtle select-none">$ </span>
              {argv}
            </pre>
          )}
          {body ? (
            <CappedText text={body} />
          ) : (
            <p className={cn(MONO, "m-0 text-ink-subtle")}>(no output)</p>
          )}
        </div>
      );
    }
  }

  const text =
    typeof result === "string" ? result : JSON.stringify(result, null, 2);
  return <CappedText text={text} />;
}

function ToolRow({ item }: { item: ToolCallItem }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const { toolName, input } = item;

  // The report can point at this exact call. Marking it is the whole signal: a
  // collapsed row scrolled into view looks like every other collapsed row, and
  // opening it would push the neighbouring steps the reader came for off screen.
  useEffect(
    () =>
      onRevealToolCall((id) => {
        if (id !== item.toolUseId) return;
        setRevealed(true);
        window.setTimeout(() => setRevealed(false), REVEAL_MS);
      }),
    [item.toolUseId],
  );
  const result =
    item.state.phase === "complete"
      ? item.state.result
      : item.state.phase === "resolved"
        ? (item.state.result ?? null)
        : null;

  const running = result === null;
  const target = targetOf(input) ?? inputString(input, "path");
  const { text: summary, tone } = resultSummary(
    toolName,
    result,
    outcomeOf(item.state),
    item.state.phase === "resolved" && item.state.decision === "rejected"
      ? "rejected"
      : undefined,
  );
  /* The one row that names its input rather than its result. What was asked is
     what a reader scanning back is looking for, and the answer is one click
     away in the body, where the exchange reads whole. */
  const line = isTool(toolName, "AskUserQuestion")
    ? clipLine(inputString(input, "question") ?? "")
    : summary;

  return (
    // Anchor for the report's evidence links: a citation there names the tool
    // call that produced it, and this is where that call lives.
    <div
      data-testid="tool-call"
      id={`tool-${item.toolUseId}`}
      data-revealed={revealed || undefined}
      className={cn(
        "-mx-2 scroll-mt-6 rounded-md px-2 transition-colors duration-(--duration-slow)",
        revealed && "bg-surface-hover",
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        disabled={running}
        onClick={() => setOpen(!open)}
        className="group flex w-full items-baseline gap-2 py-1 text-left"
      >
        <span className="shrink-0 font-mono text-sm font-medium">
          {toolName}
        </span>
        {target !== null && (
          <span className="shrink-0 font-mono text-sm text-ink-subtle">
            {target}
          </span>
        )}
        {/* Not stretched: the chevron belongs against the text it opens, so the
            row reads as one phrase rather than as a name and a control held
            apart by however much width the window happens to have. */}
        <span className={cn("min-w-0 truncate text-sm", tone)}>
          {running ? (
            <span data-testid="tool-call-pending" className="animate-pulse">
              running
            </span>
          ) : (
            line
          )}
        </span>
        {/* Always drawn, dimmed while the call is in flight. Appearing on
            completion moved the row's own text, and now that it sits in the
            reading line rather than at the margin, that jump is unmissable. */}
        <ChevronRight
          {...ICON_INLINE}
          aria-hidden="true"
          className={cn(
            "shrink-0 self-center text-ink-subtle transition-transform duration-(--duration-base) group-aria-expanded:rotate-90",
            running && "opacity-40",
          )}
        />
      </button>

      {/* No rule and no indent: the body is the evidence the row was opened
          for, so nothing here sets it back. Tight above because it belongs to
          the row, looser below because it is finished. */}
      {open && !running && (
        <div className="mt-1 mb-4">
          <ToolBody toolName={toolName} input={input} result={result} />
        </div>
      )}
    </div>
  );
}

/* The presentation registry. Tools whose result IS a rendered artifact keep
   their bespoke component; everything else is a row. */
export function ToolCall({
  item,
}: {
  item: ToolCallItem;
}): React.JSX.Element | null {
  const { toolName, input } = item;
  const result =
    item.state.phase === "complete"
      ? item.state.result
      : item.state.phase === "resolved"
        ? (item.state.result ?? null)
        : null;

  // The report card already announces this act, so a row for it would say the
  // same thing twice. Recording a hypothesis is a step, and stays visible.
  if (isTool(toolName, "SubmitInvestigationReport")) return null;

  if (isTool(toolName, "Edit", "Write")) {
    const change = result === null ? null : parseFileChange(result);
    if (change !== null)
      return <DiffCard toolName={toolName} change={change} />;
  }

  if (isTool(toolName, "OpenPullRequest")) {
    const pr = result === null ? null : parsePullRequestResult(result);
    if (pr !== null) return <PRCard pr={pr} />;
  }

  void input;
  return <ToolRow item={item} />;
}
