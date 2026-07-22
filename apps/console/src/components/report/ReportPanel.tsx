import type { Report, ReportStatus } from "@nightwatch/shared";
import { cn } from "@/lib/utils";

// The investigation report artifact rendered in the main area. Fills in live
// as the agent calls UpdateReport; the full evidence/hypothesis sections land
// with the report-artifact milestone.

const STATUS_CHIP: Record<ReportStatus, { label: string; className: string }> =
  {
    investigation_incomplete: {
      label: "Investigating",
      className: "bg-run-tint text-run",
    },
    root_cause_identified: {
      label: "Resolved",
      className: "bg-ok-tint text-ok",
    },
    inconclusive: {
      label: "Inconclusive",
      className: "bg-surface text-muted-foreground",
    },
  };

function StatusChip({ status }: { status: ReportStatus }): React.JSX.Element {
  const chip = STATUS_CHIP[status];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold",
        chip.className,
      )}
    >
      {chip.label}
    </span>
  );
}

export function ReportPanel({ report }: { report: Report }): React.JSX.Element {
  const resolved = report.hypotheses.filter((h) => h.state !== "open").length;

  return (
    <div className="mx-auto w-full max-w-page px-8 py-6">
      <header className="mb-6 flex items-center gap-3">
        <h1 className="m-0 min-w-0 flex-1 truncate text-2xl font-semibold tracking-[-0.3px]">
          {report.headline || "Investigation"}
        </h1>
        <StatusChip status={report.status} />
      </header>

      {report.rootCause.summary && (
        <section className="mb-6">
          <h2 className="mb-1 text-sm font-medium uppercase tracking-[0.06em] text-muted-foreground">
            Root cause
          </h2>
          <p className="m-0 text-base font-medium">
            {report.rootCause.summary}
          </p>
          {report.rootCause.detail && (
            <p className="m-0 mt-1 text-sm text-muted-foreground">
              {report.rootCause.detail}
            </p>
          )}
        </section>
      )}

      {report.hypotheses.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-sm font-medium uppercase tracking-[0.06em] text-muted-foreground">
            Hypotheses · {resolved} of {report.hypotheses.length} resolved
          </h2>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {report.hypotheses.map((h) => (
              <li
                key={h.id}
                className="rounded-lg border border-border bg-card px-4 py-3"
              >
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "text-xs font-semibold uppercase tracking-[0.05em]",
                      h.state === "root_cause"
                        ? "text-ok"
                        : h.state === "disproven"
                          ? "text-muted-foreground line-through"
                          : "text-run",
                    )}
                  >
                    {h.state === "root_cause"
                      ? "Root cause"
                      : h.state === "disproven"
                        ? "Disproven"
                        : "Open"}
                  </span>
                  <span className="text-xs text-ink-subtle">
                    {h.confidence} confidence
                  </span>
                </div>
                <p className="m-0 mt-1 text-sm">{h.statement}</p>
                {h.reason && (
                  <p className="m-0 mt-1 text-sm text-muted-foreground">
                    {h.reason}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {report.proposedFix.summary && (
        <section className="mb-6">
          <h2 className="mb-1 text-sm font-medium uppercase tracking-[0.06em] text-muted-foreground">
            Proposed fix
          </h2>
          <p className="m-0 text-sm font-medium">
            {report.proposedFix.summary}
          </p>
          {report.proposedFix.steps.length > 0 && (
            <ol className="m-0 mt-2 flex flex-col gap-1 pl-5 text-sm text-muted-foreground">
              {report.proposedFix.steps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          )}
        </section>
      )}

      {report.status === "inconclusive" && !report.rootCause.summary && (
        <p className="text-sm text-muted-foreground">
          The investigation ended without identifying a root cause.
        </p>
      )}
    </div>
  );
}
