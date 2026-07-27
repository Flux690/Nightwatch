import { Card, CardContent } from "@/components/ui/card";
import { TOOL_CARD_CLASS } from "./cardChrome.js";
import { cn } from "@/lib/utils";

export type DiffLineType = "added" | "removed" | "unchanged";
export interface DiffLine {
  type: DiffLineType;
  oldLineNumber: number | null;
  newLineNumber: number | null;
  content: string;
}
export interface DiffHunk {
  lines: DiffLine[];
}
export interface FileChange {
  path: string;
  hunks: DiffHunk[];
}

/* Live results arrive as objects, persisted ones as the JSON string the
   tool_result carried; accept both, reject anything else (e.g. plain error strings). */
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
  if (typeof record["path"] !== "string" || !Array.isArray(record["hunks"])) {
    return null;
  }
  return { path: record["path"], hunks: record["hunks"] };
}

function lineClass(type: DiffLineType): string {
  if (type === "added") return "bg-success-tint text-success";
  if (type === "removed") return "bg-destructive-tint text-destructive";
  return "text-foreground";
}

export function DiffCard({
  toolName,
  change,
}: {
  toolName: string;
  change: FileChange;
}): React.JSX.Element {
  const allLines = change.hunks.flatMap((hunk) => hunk.lines);
  const added = allLines.filter((l) => l.type === "added").length;
  const removed = allLines.filter((l) => l.type === "removed").length;

  return (
    <div data-testid="diff-card">
      <p className="mb-1.5 font-mono text-base font-medium">
        {toolName}
        <span className="ml-2 text-muted-foreground">{change.path}</span>
        <span className="ml-2 text-success">+{added}</span>
        <span className="ml-1 text-destructive">-{removed}</span>
      </p>
      <Card size="sm" className={TOOL_CARD_CLASS}>
        <CardContent className="max-h-[360px] overflow-hidden px-0 py-2 font-mono text-base leading-relaxed">
          {change.hunks.map((hunk, hunkIndex) => (
            <div key={hunkIndex} className={hunkIndex > 0 ? "mt-3" : ""}>
              {hunk.lines.map((line, i) => (
                <div
                  key={i}
                  className={cn(
                    "flex gap-3 break-all whitespace-pre-wrap px-3.5",
                    lineClass(line.type),
                  )}
                >
                  <span className="w-8 shrink-0 select-none text-right text-muted-foreground">
                    {line.oldLineNumber ?? ""}
                  </span>
                  <span className="w-8 shrink-0 select-none text-right text-muted-foreground">
                    {line.newLineNumber ?? ""}
                  </span>
                  <span className="flex-1">
                    {line.content.length > 0 ? line.content : " "}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
