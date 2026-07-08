import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface FileChange {
  path: string;
  diff: string;
}

/* Live results arrive as objects; persisted transcripts replay them as the
   JSON string the tool_result carried. Accept both, reject everything else
   (error results are plain strings and fall back to the generic panel). */
export function parseFileChange(result: unknown): FileChange | null {
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
    typeof record["path"] !== "string" ||
    typeof record["diff"] !== "string"
  ) {
    return null;
  }
  return { path: record["path"], diff: record["diff"] };
}

function lineClass(line: string): string {
  if (line.startsWith("@@")) return "text-muted-foreground";
  if (line.startsWith("+")) return "bg-success-tint text-success";
  if (line.startsWith("-")) return "bg-destructive-tint text-destructive";
  return "text-foreground";
}

export function DiffCard({
  toolName,
  change,
}: {
  toolName: string;
  change: FileChange;
}): React.JSX.Element {
  const lines = change.diff
    .split("\n")
    .filter((l) => !l.startsWith("--- ") && !l.startsWith("+++ "));

  return (
    <div data-testid="diff-card">
      <p className="mb-1.5 font-mono text-xs font-medium">
        {toolName}
        <span className="ml-2 text-muted-foreground">{change.path}</span>
      </p>
      <Card size="sm" className="gap-0 py-0">
        <CardContent className="max-h-96 overflow-auto px-0 py-2 font-mono text-sm leading-relaxed">
          {lines.map((line, i) => (
            <div
              key={i}
              className={cn(
                "break-all whitespace-pre-wrap px-3.5",
                lineClass(line),
              )}
            >
              {line.length > 0 ? line : " "}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
