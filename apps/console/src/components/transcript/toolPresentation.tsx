import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { ICON_INLINE } from "@/lib/iconProps";
import type { ToolCardItem } from "./types.js";
import { DiffCard, parseFileChange } from "./DiffCard.js";
import {
  CARD_PRE_CLASS,
  TerminalCard,
  TOOL_CARD_CLASS,
} from "./TerminalCard.js";
import { PRCard, parsePullRequestResult } from "./PRCard.js";

function inputString(
  input: Record<string, unknown>,
  key: string,
): string | null {
  const value = input[key];
  return typeof value === "string" ? value : null;
}

// Human target for fleet tools: the service/workload segment of the target key,
// or the server name for host tools.
function targetOf(input: Record<string, unknown>): string | null {
  const target = input["target"];
  if (typeof target === "string") {
    const parts = target.split("/");
    return parts[parts.length - 1] ?? target;
  }
  return inputString(input, "server");
}

export function ToolHeader({
  name,
  summary,
}: {
  name: string;
  summary?: string | null;
}): React.JSX.Element {
  return (
    <p className="mb-1.5 font-mono text-base font-medium">
      {name}
      {summary ? (
        <span className="ml-2 font-normal text-muted-foreground">
          {summary}
        </span>
      ) : null}
    </p>
  );
}

function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2);
}

// Collapsed by default. Raw tool output is evidence to check, not the thing a
// reader is following, and at rail width it buries everything around it.
function OutputCard({ result }: { result: unknown }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const text = resultText(result);
  const lines = text.split("\n").length;

  if (!open) {
    return (
      <button
        type="button"
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(true)}
      >
        <ChevronRight {...ICON_INLINE} />
        {lines > 1 ? `${lines} lines` : "output"}
      </button>
    );
  }

  return (
    <div>
      <button
        type="button"
        className="mb-1 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(false)}
      >
        <ChevronDown {...ICON_INLINE} />
        {lines > 1 ? `${lines} lines` : "output"}
      </button>
      <Card size="sm" className={TOOL_CARD_CLASS}>
        <CardContent className="max-h-72 overflow-auto px-3.5 py-2.5">
          <pre className={CARD_PRE_CLASS}>{text}</pre>
        </CardContent>
      </Card>
    </div>
  );
}

/* The single presentation registry: input collapses into the header line and
   the body exists only once a result does; IN/OUT chrome is for shell tools. */
export function ToolCard({ item }: { item: ToolCardItem }): React.JSX.Element {
  const { toolName, input } = item;
  // Null until the call finishes, which is what the IN/OUT chrome keys off.
  const result =
    item.state.phase === "complete"
      ? item.state.result
      : item.state.phase === "resolved"
        ? (item.state.result ?? null)
        : null;

  if (toolName === "Read" || toolName === "ReadHostFile") {
    const path = inputString(input, "path") ?? "";
    const server = inputString(input, "server");
    return (
      <div data-testid="tool-card">
        <ToolHeader
          name="Read"
          summary={server === null ? path : `${path} on ${server}`}
        />
      </div>
    );
  }

  if (toolName === "Edit" || toolName === "Write") {
    const change = result === null ? null : parseFileChange(result);
    if (change !== null)
      return <DiffCard toolName={toolName} change={change} />;
    return (
      <div data-testid="tool-card">
        <ToolHeader name={toolName} summary={inputString(input, "path")} />
        {result !== null && <OutputCard result={result} />}
      </div>
    );
  }

  if (toolName === "Bash") {
    return (
      <TerminalCard
        name="Bash"
        description={inputString(input, "description")}
        command={inputString(input, "command") ?? ""}
        result={result}
      />
    );
  }

  if (toolName === "DockerBash" || toolName === "K8sBash") {
    const argv = Array.isArray(input["command"])
      ? (input["command"] as unknown[]).map(String).join(" ")
      : "";
    return (
      <TerminalCard
        name={toolName}
        target={targetOf(input)}
        description={inputString(input, "reason")}
        command={argv}
        result={result}
      />
    );
  }

  if (toolName === "OpenPullRequest") {
    const pr = result === null ? null : parsePullRequestResult(result);
    if (pr !== null) return <PRCard pr={pr} />;
    return (
      <div data-testid="tool-card">
        <ToolHeader
          name="OpenPullRequest"
          summary={inputString(input, "title")}
        />
        {result !== null && <OutputCard result={result} />}
      </div>
    );
  }

  return (
    <div data-testid="tool-card">
      <ToolHeader name={toolName} summary={targetOf(input)} />
      {result !== null && <OutputCard result={result} />}
    </div>
  );
}
