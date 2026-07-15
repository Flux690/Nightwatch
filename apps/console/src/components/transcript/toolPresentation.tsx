import { Card, CardContent } from "@/components/ui/card";
import type { ToolCardItem } from "./types.js";
import { DiffCard, parseFileChange } from "./DiffCard.js";
import {
  CARD_PRE_CLASS,
  firstLines,
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

// Human target for fleet tools: the service identity's name, or the server.
function targetOf(input: Record<string, unknown>): string | null {
  const service = input["service"];
  if (typeof service === "string") return service;
  if (typeof service === "object" && service !== null) {
    const s = service as Record<string, unknown>;
    const name = s["service"] ?? s["workload"];
    if (typeof name === "string") return name;
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

function OutputCard({ result }: { result: unknown }): React.JSX.Element {
  return (
    <Card size="sm" className={TOOL_CARD_CLASS}>
      <CardContent className="px-3.5 py-2.5">
        <pre className={CARD_PRE_CLASS}>{firstLines(resultText(result))}</pre>
      </CardContent>
    </Card>
  );
}

/* The single presentation registry: input collapses into the header line and
   the body exists only once a result does; IN/OUT chrome is for shell tools. */
export function ToolCard({ item }: { item: ToolCardItem }): React.JSX.Element {
  const { toolName, input, result } = item;

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
