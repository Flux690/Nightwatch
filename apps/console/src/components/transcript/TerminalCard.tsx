import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { ICON_INLINE } from "@/lib/iconProps";
import { cn } from "@/lib/utils";

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

// A character cap alongside the line cap, because one enormous line is a single
// "line" that wraps into dozens of rows in a narrow rail.
const CARD_MAX_CHARS = 300;

export function firstLines(text: string, max = CARD_MAX_LINES): string {
  const lines = text.split("\n").slice(0, max).join("\n");
  return lines.length > CARD_MAX_CHARS
    ? `${lines.slice(0, CARD_MAX_CHARS)}...`
    : lines;
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

// The preview is the finding; the rest is evidence, one click away in a region
// that scrolls rather than pushing the conversation off screen.
function OutputBody({ text }: { text: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  if (text.trim().length === 0)
    return <pre className={CARD_PRE_CLASS}>(no output)</pre>;

  const preview = firstLines(text);
  if (preview === text) return <pre className={CARD_PRE_CLASS}>{text}</pre>;

  const rest = text.split("\n").length - CARD_MAX_LINES;
  return (
    <div>
      <pre className={cn(CARD_PRE_CLASS, open && "max-h-72 overflow-auto")}>
        {open ? text : preview}
      </pre>
      <button
        type="button"
        className="mt-1 flex items-center gap-1 font-mono text-sm text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(!open)}
      >
        {open ? (
          <ChevronDown {...ICON_INLINE} />
        ) : (
          <ChevronRight {...ICON_INLINE} />
        )}
        {open ? "less" : rest > 0 ? `${rest} more lines` : "more"}
      </button>
    </div>
  );
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
            <OutputBody text={output} />
          </CardContent>
        )}
      </Card>
    </div>
  );
}
