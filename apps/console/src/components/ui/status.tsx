import { cn } from "@/lib/utils";

/* One way to show state: a dot and a word.
 *
 * A filled pill is a shape that says "look at me" regardless of what it says,
 * so a screen with six of them has no hierarchy left. The dot carries the
 * colour, the word carries the meaning, and neither competes with the content
 * beside it. Colour is never the only signal - the label always states the
 * state in words. */

export type StatusTone = "ok" | "run" | "warn" | "fail" | "muted";

const DOT: Record<StatusTone, string> = {
  ok: "bg-ok",
  run: "bg-run",
  warn: "bg-wait",
  fail: "bg-fail",
  muted: "bg-border-strong",
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
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-sm whitespace-nowrap",
        tone === "muted" ? "text-muted-foreground" : "text-foreground",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 shrink-0 rounded-full", DOT[tone])}
      />
      {children}
    </span>
  );
}

/* A fact about a thing, not a state of it: "Private", "Auth", "Tenant". These
   were pills too, which gave a static attribute the same weight as a live
   status. Plain subdued text is the whole of what they need. */
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
