import { cn } from "@/shared/lib/utils";
import type { CandidateRow } from "./types.js";

// The same ranking as the report, with a word so colour is never the only
// signal: accent for the cause, ink for a standing role, grey for a dismissal.
const STATE: Record<
  CandidateRow["state"],
  { label: string; className: string; struck?: boolean }
> = {
  open: { label: "open", className: "text-wait" },
  reopened: { label: "reopened", className: "text-run" },
  root_cause: { label: "root cause", className: "text-primary-ink" },
  trigger: { label: "trigger", className: "text-foreground" },
  symptom: { label: "symptom", className: "text-foreground" },
  contributing_factor: { label: "contributing", className: "text-foreground" },
  disproven: { label: "ruled out", className: "text-ink-subtle", struck: true },
  untestable: { label: "untestable", className: "text-ink-subtle" },
};

// The board of candidates, drawn where the run opened them and refreshed in
// place as each is settled or reopened.
export function CandidateCard({
  rows,
}: {
  rows: CandidateRow[];
}): React.JSX.Element {
  return (
    <div className="animate-in fade-in overflow-hidden rounded-lg border border-border bg-card duration-(--duration-slow)">
      <div className="border-b border-border px-4 py-3 text-sm font-medium">
        Candidates
      </div>
      <ul className="m-0 flex list-none flex-col p-0">
        {rows.map((row) => {
          const view = STATE[row.state];
          return (
            <li
              key={row.statement}
              className="grid grid-cols-[1fr_max-content] items-baseline gap-x-3 gap-y-1 border-t border-border px-4 py-3 first:border-t-0"
            >
              <span
                className={cn(
                  "text-sm",
                  view.struck &&
                    "text-muted-foreground line-through decoration-muted-foreground/50",
                )}
              >
                {row.statement}
              </span>
              <span className={cn("text-xs whitespace-nowrap", view.className)}>
                {view.label}
              </span>
              {row.note !== undefined && (
                <span className="col-span-2 text-xs leading-relaxed text-muted-foreground">
                  {row.note}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
