import { cn } from "@/shared/lib/utils";

// A word in the tone of the state it names. A dot beside it carries nothing
// the word does not, and colour is never the only signal.

export type StatusTone = "ok" | "run" | "warn" | "fail" | "muted";

const TONE: Record<StatusTone, string> = {
  ok: "text-ok",
  run: "text-run",
  warn: "text-wait",
  fail: "text-fail",
  muted: "text-muted-foreground",
};

export function StatusText({
  tone,
  children,
  className,
}: {
  tone: StatusTone;
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <span className={cn("text-sm whitespace-nowrap", TONE[tone], className)}>
      {children}
    </span>
  );
}

// A fact about a thing, not a state of it. As pills these gave a static
// attribute the same weight as a live status.
export function MetaText({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        "text-sm whitespace-nowrap text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}
