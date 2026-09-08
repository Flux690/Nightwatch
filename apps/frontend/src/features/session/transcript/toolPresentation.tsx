// The row names the call and the body is one click inside it. Expansion is a
// thread line: at rail width a box per tool buries the conversation.

import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { ICON_INLINE } from "@/shared/lib/iconProps";
import { Button } from "@/shared/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/shared/ui/collapsible";
import { onRevealToolCall, REVEAL_MS } from "./revealToolCall.js";
import { cn } from "@/shared/lib/utils";
import { isTool, parseTargetKey } from "@nightwarden/shared";
import type { ToolName } from "@nightwarden/shared";
import { stringAt as inputString } from "@/shared/lib/toolResult";
import type { ToolCallItem } from "./types.js";
import { DiffCard, parseFileChange } from "./DiffCard.js";
import { PRCard, parsePullRequestResult } from "./PRCard.js";
import { parseCommandRun } from "./TerminalCard.js";

// Beyond this the body scrolls behind an explicit opt-in. The runner's own 64KB
// cap is for safety; this much tighter one is for reading.
const BODY_MAX_LINES = 8;

// Shared with the approval card, which labels the same three as one action.
export const COMMAND_TOOLS: readonly ToolName[] = [
  "DockerExec",
  "K8sExec",
  "Bash",
];

// Service tools address one service by target key; server tools name a server.
// Shared with the report, so a cited call names its target the same way there.
export function targetOf(input: Record<string, unknown>): string | null {
  const target = input["target"];
  if (typeof target === "string") {
    return parseTargetKey(target)?.name ?? target;
  }
  return inputString(input, "server");
}

// The exec tools carry a program and its arguments; repo Bash carries a shell
// string. Shared with the approval card, where what is read has to be what runs.
export function commandLineOf(input: Record<string, unknown>): string | null {
  const executable = input["executable"];
  if (typeof executable === "string") {
    const args = Array.isArray(input["args"]) ? input["args"].map(String) : [];
    return [executable, ...args].join(" ");
  }
  return inputString(input, "command");
}

const MONO = "font-mono text-sm leading-relaxed";

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

/* Only the two a raw block cannot serve: a question needs the question beside
   the answer, and a command needs its own line above its output. */
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

  const run = isTool(toolName, ...COMMAND_TOOLS)
    ? parseCommandRun(result)
    : null;
  if (run !== null) {
    return (
      <div className="flex flex-col gap-2">
        <pre className={cn(MONO, "m-0 whitespace-pre-wrap break-words")}>
          <span className="text-ink-subtle select-none">$ </span>
          {commandLineOf(input) ?? ""}
        </pre>
        {run.output.trim() === "" ? (
          <p className={cn(MONO, "m-0 text-ink-subtle")}>(no output)</p>
        ) : (
          <CappedText text={run.output} />
        )}
      </div>
    );
  }

  const text =
    typeof result === "string" ? result : JSON.stringify(result, null, 2);
  return <CappedText text={text} />;
}

function ToolRow({ item }: { item: ToolCallItem }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const { toolName, input } = item;

  // Marking is the whole signal: a collapsed row scrolled into view looks like
  // every other, and opening it would push the neighbouring steps off screen.
  useEffect(
    () =>
      onRevealToolCall((id) => {
        if (id !== item.toolCallId) return;
        setRevealed(true);
        window.setTimeout(() => setRevealed(false), REVEAL_MS);
      }),
    [item.toolCallId],
  );
  const result =
    item.state.phase === "complete"
      ? item.state.result
      : item.state.phase === "resolved"
        ? (item.state.result ?? null)
        : null;

  const running = result === null;
  const target = targetOf(input) ?? inputString(input, "path");

  return (
    // Anchor for the report's evidence links: a citation there names the tool
    // call that produced it, and this is where that call lives.
    <div
      data-testid="tool-call"
      id={`tool-${item.toolCallId}`}
      data-revealed={revealed || undefined}
      className={cn(
        "-mx-2 scroll-mt-6 rounded-md px-2 transition-colors duration-(--duration-slow)",
        revealed && "bg-surface-hover",
      )}
    >
      <Collapsible open={open} onOpenChange={setOpen} disabled={running}>
        <CollapsibleTrigger
          disabled={running}
          nativeButton
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
          {running && (
            <span
              data-testid="tool-call-pending"
              className="min-w-0 text-sm text-ink-subtle animate-pulse"
            >
              running
            </span>
          )}
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
        </CollapsibleTrigger>

        {/* No rule and no indent: the body is the evidence the row was opened
          for, so nothing here sets it back. Tight above because it belongs to
          the row, looser below because it is finished. */}
        {!running && (
          <CollapsibleContent className="mt-1 mb-4">
            <ToolBody toolName={toolName} input={input} result={result} />
          </CollapsibleContent>
        )}
      </Collapsible>
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
