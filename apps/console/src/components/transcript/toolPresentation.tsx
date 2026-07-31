import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { ICON_INLINE } from "@/lib/iconProps";
import { onRevealToolCall, REVEAL_MS } from "./revealToolCall.js";
import { cn } from "@/lib/utils";
import type { ToolCallState, ToolCardItem, ToolOutcome } from "./types.js";
import { DiffCard, parseFileChange } from "./DiffCard.js";
import { PRCard, parsePullRequestResult } from "./PRCard.js";
import { findingFor, formatBytes } from "./toolFindings.js";

/* One row shape for every tool: name, target, the finding, and a chevron.
   The row carries the answer so the common case needs no click, and expansion
   is a thread line rather than a card - at rail width a bordered box per tool
   buries the conversation it is supposed to explain. */

// Beyond this the body scrolls behind an explicit opt-in. The runner already
// caps its output at 64KB for safety; this is the separate, much tighter cap
// for something a person is meant to read.
const BODY_MAX_LINES = 8;

const SHELL_TOOLS = new Set(["DockerBash", "K8sBash", "Bash"]);

function inputString(
  input: Record<string, unknown>,
  key: string,
): string | null {
  const value = input[key];
  return typeof value === "string" ? value : null;
}

// Fleet tools address a service by target key; host tools name a server.
function targetOf(input: Record<string, unknown>): string | null {
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

function parseResult(result: unknown): Record<string, unknown> | null {
  let value = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
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
      <button
        type="button"
        className="mt-1.5 text-sm text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground"
        onClick={() => setOpen(!open)}
      >
        {open ? "Show less" : `Show all ${lines.length} lines`}
      </button>
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
    <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
      {events.slice(0, BODY_MAX_LINES).map((event, i) => {
        const at =
          typeof event["timestamp"] === "string" ? event["timestamp"] : "";
        const label =
          typeof event["eventType"] === "string" ? event["eventType"] : "";
        return (
          <li key={`${at}-${i}`} className={cn(MONO, "flex gap-2.5")}>
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
// honest: better a JSON block than a shape we pretended to understand.
function ToolBody({
  toolName,
  input,
  result,
}: {
  toolName: string;
  input: Record<string, unknown>;
  result: unknown;
}): React.JSX.Element {
  const record = parseResult(result);

  if (record !== null) {
    if (toolName === "GetDockerLogs" || toolName === "GetK8sLogs") {
      return <LogLines lines={stringList(record["lines"])} />;
    }

    if (toolName === "GetDockerEvents" || toolName === "GetK8sEvents") {
      const events = Array.isArray(record["events"])
        ? (record["events"] as Record<string, unknown>[])
        : [];
      return <EventList events={events} />;
    }

    if (toolName === "GetDockerStats" || toolName === "GetK8sStats") {
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

    if (toolName === "GetHostMemory") {
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

    if (toolName === "GetDockerConfig" || toolName === "GetK8sConfig") {
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
    if (SHELL_TOOLS.has(toolName)) {
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

export function ToolRow({ item }: { item: ToolCardItem }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const { toolName, input } = item;

  // The report can point at this exact call. Opening it is the whole signal:
  // a collapsed row scrolled into view looks like every other collapsed row.
  useEffect(
    () =>
      onRevealToolCall((id) => {
        if (id !== item.toolUseId) return;
        setOpen(true);
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
  const finding = findingFor(toolName, result);
  const target = targetOf(input) ?? inputString(input, "path");
  const outcome = outcomeOf(item.state);
  // The class outranks the finding's own tone: the finding is read off the
  // result, and a result that never arrived has nothing to read.
  const tone =
    outcome !== undefined
      ? OUTCOME_TONE[outcome]
      : finding?.tone === "bad"
        ? "text-fail"
        : "text-muted-foreground";
  const label = outcome === undefined ? "" : OUTCOME_LABEL[outcome];
  const summary = [label, finding?.text].filter(Boolean).join(" · ");

  return (
    // Anchor for the report's evidence links: a citation there names the tool
    // call that produced it, and this is where that call lives.
    <div
      data-testid="tool-card"
      id={`tool-${item.toolUseId}`}
      data-revealed={revealed || undefined}
      className={cn(
        "-mx-2 scroll-mt-6 rounded-md px-2 transition-colors duration-500",
        revealed && "bg-accent-tint",
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
        <span className={cn("min-w-0 flex-1 truncate text-sm", tone)}>
          {running ? (
            <span data-testid="tool-card-pending" className="animate-pulse">
              running
            </span>
          ) : (
            summary
          )}
        </span>
        {!running && (
          <ChevronRight
            {...ICON_INLINE}
            aria-hidden="true"
            className="shrink-0 self-center text-ink-subtle transition-transform duration-200 group-aria-expanded:rotate-90"
          />
        )}
      </button>

      {open && !running && (
        <div className="mt-0.5 mb-2 border-l border-border py-1 pl-3.5">
          <ToolBody toolName={toolName} input={input} result={result} />
        </div>
      )}
    </div>
  );
}

/* The presentation registry. Tools whose result IS a rendered artifact keep
   their bespoke component; everything else is a row. */
export function ToolCard({
  item,
}: {
  item: ToolCardItem;
}): React.JSX.Element | null {
  const { toolName, input } = item;
  const result =
    item.state.phase === "complete"
      ? item.state.result
      : item.state.phase === "resolved"
        ? (item.state.result ?? null)
        : null;

  // The report has its own panel; showing its bookkeeping as a step in the
  // transcript is noise the reader has to skip past.
  if (toolName === "UpdateReport") return null;

  if (toolName === "Edit" || toolName === "Write") {
    const change = result === null ? null : parseFileChange(result);
    if (change !== null)
      return <DiffCard toolName={toolName} change={change} />;
  }

  if (toolName === "OpenPullRequest") {
    const pr = result === null ? null : parsePullRequestResult(result);
    if (pr !== null) return <PRCard pr={pr} />;
  }

  void input;
  return <ToolRow item={item} />;
}
