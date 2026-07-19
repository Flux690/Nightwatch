import { Card, CardContent } from "@/components/ui/card";

export interface ExecResult {
  exitCode: number;
  output: string;
  truncated?: boolean;
}

/* Object live, JSON string on transcript reload - see DiffCard.parseFileChange. */
export function parseExecResult(result: unknown): ExecResult | null {
  let value = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record["exitCode"] !== "number" ||
    typeof record["output"] !== "string"
  ) {
    return null;
  }
  return {
    exitCode: record["exitCode"],
    output: record["output"],
    ...(record["truncated"] === true && { truncated: true }),
  };
}

// Cards never scroll: IN and OUT each show at most this many lines.
export const CARD_MAX_LINES = 3;

export function firstLines(text: string, max = CARD_MAX_LINES): string {
  return text.split("\n").slice(0, max).join("\n");
}

export const TOOL_CARD_CLASS =
  "gap-0 rounded-none border border-border py-0 ring-0";
export const IO_LABEL_CLASS =
  "mb-1.5 font-mono text-sm font-medium tracking-[0.06em] text-muted-foreground";
export const CARD_PRE_CLASS =
  "m-0 overflow-hidden font-mono text-base break-all whitespace-pre-wrap";

function rawText(result: unknown): string {
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2);
}

export function TerminalCard({
  name,
  target,
  description,
  command,
  result,
}: {
  name: string;
  target?: string | null;
  description?: string | null;
  command: string;
  // null while the command is still running; the OUT section only exists
  // once there is output.
  result: unknown;
}): React.JSX.Element {
  const exec = result === null ? null : parseExecResult(result);
  const output =
    result === null ? null : exec !== null ? exec.output : rawText(result);

  return (
    <div data-testid="terminal-card">
      <p className="mb-1.5 font-mono text-base font-medium">
        {name}
        {target ? (
          <span className="ml-2 font-normal text-muted-foreground">
            {target}
          </span>
        ) : null}
        {description ? (
          <span className="ml-2 font-normal text-muted-foreground">
            {description}
          </span>
        ) : null}
      </p>
      <Card size="sm" className={TOOL_CARD_CLASS}>
        <CardContent className="px-3.5 py-2.5">
          <p className={IO_LABEL_CLASS}>
            IN
            {result === null && (
              <span
                data-testid="tool-card-pending"
                className="ml-2 animate-pulse font-normal normal-case"
              >
                running
              </span>
            )}
          </p>
          <pre className={CARD_PRE_CLASS}>{firstLines(command)}</pre>
        </CardContent>
        {output !== null && (
          <CardContent className="border-t border-border px-3.5 py-2.5">
            <p className={IO_LABEL_CLASS}>OUT</p>
            <pre className={CARD_PRE_CLASS}>
              {output.trim().length > 0 ? firstLines(output) : "(no output)"}
            </pre>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
