import { Badge } from "@/components/ui/badge";
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

function rawText(result: unknown): string {
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2);
}

export function TerminalCard({
  name,
  target,
  description,
  command,
  cwd,
  result,
}: {
  name: string;
  target?: string | null;
  description?: string | null;
  command: string;
  cwd?: string | null;
  // null while the command is still running; the output area only exists
  // once there is output.
  result: unknown;
}): React.JSX.Element {
  const exec = result === null ? null : parseExecResult(result);
  const bodyText =
    result === null ? "" : exec !== null ? exec.output : rawText(result);

  return (
    <div data-testid="terminal-card">
      <p className="mb-1.5 font-mono text-xs font-medium">
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
      <Card size="sm" className="gap-0 rounded-none py-0">
        <CardContent className="flex items-center gap-2 px-3.5 py-2">
          <span className="min-w-0 flex-1 truncate font-mono text-sm">
            <span className="text-muted-foreground">
              {cwd == null ? "$" : `${cwd} $`}
            </span>{" "}
            {command}
          </span>
          {result === null ? (
            <span
              data-testid="tool-card-pending"
              className="animate-pulse font-mono text-xs text-muted-foreground"
            >
              running
            </span>
          ) : exec !== null && exec.exitCode !== 0 ? (
            <Badge variant="destructive">exit {exec.exitCode}</Badge>
          ) : null}
        </CardContent>
        {bodyText.trim().length > 0 && (
          <CardContent className="border-t border-border px-3.5 py-2.5">
            <pre className="m-0 max-h-80 overflow-auto font-mono text-sm break-all whitespace-pre-wrap">
              {bodyText}
            </pre>
            {exec?.truncated === true && (
              <p className="mt-1.5 font-mono text-xs text-muted-foreground">
                output truncated (head and tail shown)
              </p>
            )}
          </CardContent>
        )}
      </Card>
    </div>
  );
}
