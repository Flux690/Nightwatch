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

export function TerminalCard({
  input,
  result,
}: {
  input: Record<string, unknown>;
  result: ExecResult;
}): React.JSX.Element {
  const command = typeof input["command"] === "string" ? input["command"] : "";
  const cwd = typeof input["cwd"] === "string" ? input["cwd"] : null;

  return (
    <div data-testid="terminal-card">
      <p className="mb-1.5 font-mono text-xs font-medium">Bash</p>
      <Card size="sm" className="gap-0 py-0">
        <CardContent className="flex items-center gap-2 border-b border-border px-3.5 py-2">
          <span className="min-w-0 flex-1 truncate font-mono text-sm">
            <span className="text-muted-foreground">
              {cwd === null ? "$" : `${cwd} $`}
            </span>{" "}
            {command}
          </span>
          <Badge variant={result.exitCode === 0 ? "success" : "destructive"}>
            exit {result.exitCode}
          </Badge>
        </CardContent>
        <CardContent className="px-3.5 py-2.5">
          <pre className="m-0 max-h-80 overflow-auto font-mono text-sm break-all whitespace-pre-wrap">
            {result.output}
          </pre>
          {result.truncated === true && (
            <p className="mt-1.5 font-mono text-xs text-muted-foreground">
              output truncated (head and tail shown)
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
