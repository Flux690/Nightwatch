import type {
  ChangesSnapshot,
  ChartSnapshot,
  EvidenceItem,
  Report,
  ReportStatus,
} from "@nightwarden/shared";
import { cn } from "@/lib/utils";

// The investigation report artifact rendered in the main area, filling in live
// as the agent calls UpdateReport. Snapshots are frozen into the report, so
// evidence renders forever - nothing here re-queries a data source.

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

/* Numbered citation chips: click scrolls to the cited evidence card. The
   number is the card's position in the evidence section, so chip and card
   always agree. */
function CitationChips({
  ids,
  evidence,
}: {
  ids: string[];
  evidence: EvidenceItem[];
}): React.JSX.Element | null {
  const cited = ids
    .map((id) => ({ id, index: evidence.findIndex((e) => e.id === id) }))
    .filter((c) => c.index !== -1);
  if (cited.length === 0) return null;
  return (
    <span className="ml-1.5 inline-flex gap-1 align-middle">
      {cited.map(({ id, index }) => (
        <button
          key={id}
          type="button"
          aria-label={`Show evidence ${index + 1}`}
          className="rounded-full bg-accent-tint px-1.5 py-px text-[10px] font-semibold text-run transition-colors hover:bg-accent-wash"
          onClick={() =>
            document
              .getElementById(`evidence-${id}`)
              ?.scrollIntoView({ behavior: "smooth", block: "center" })
          }
        >
          e{index + 1}
        </button>
      ))}
    </span>
  );
}

const CHART_W = 640;
const CHART_H = 140;
const CHART_PAD = 8;

const compact = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function timeLabel(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/* Hand-rolled inline SVG line chart from the frozen snapshot points - no
   charting dependency, no re-query, renders after retention expiry. */
function EvidenceChart({
  snapshot,
}: {
  snapshot: ChartSnapshot;
}): React.JSX.Element | null {
  const { points, seriesLabel } = snapshot;
  if (points.length < 2) return null;

  const values = points.map(([, v]) => v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number): number =>
    CHART_PAD + (i / (points.length - 1)) * (CHART_W - 2 * CHART_PAD);
  const y = (v: number): number =>
    CHART_H - CHART_PAD - ((v - min) / span) * (CHART_H - 2 * CHART_PAD);
  const line = points.map(([, v], i) => `${x(i)},${y(v)}`).join(" ");
  const area = `${CHART_PAD},${CHART_H - CHART_PAD} ${line} ${CHART_W - CHART_PAD},${CHART_H - CHART_PAD}`;

  return (
    <figure className="m-0 mt-3">
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        role="img"
        aria-label={seriesLabel}
        className="w-full rounded-md border border-border bg-background"
      >
        <polygon points={area} className="fill-run-tint" />
        <polyline
          points={line}
          className="stroke-run fill-none"
          strokeWidth={1.5}
          strokeLinejoin="round"
        />
      </svg>
      <figcaption className="mt-1 flex justify-between text-xs text-muted-foreground">
        <span className="min-w-0 truncate">{seriesLabel}</span>
        <span className="shrink-0">
          {compact.format(min)}–{compact.format(max)} ·{" "}
          {timeLabel(points[0]![0])}–{timeLabel(points[points.length - 1]![0])}
        </span>
      </figcaption>
    </figure>
  );
}

function ChangesList({
  snapshot,
}: {
  snapshot: ChangesSnapshot;
}): React.JSX.Element | null {
  if (snapshot.pullRequests.length === 0) return null;
  return (
    <ul className="m-0 mt-3 flex list-none flex-col gap-1.5 p-0">
      {snapshot.pullRequests.map((pr) => (
        <li key={pr.number} className="flex min-w-0 items-baseline gap-2">
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 truncate text-sm font-medium text-ring no-underline hover:underline"
          >
            #{pr.number} {pr.title}
          </a>
          <span className="shrink-0 text-xs text-muted-foreground">
            {pr.author} · merged {timeLabel(pr.mergedAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function SectionHeading({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <h2 className="mb-2 text-sm font-medium uppercase tracking-[0.06em] text-muted-foreground">
      {children}
    </h2>
  );
}

export function ReportPanel({ report }: { report: Report }): React.JSX.Element {
  const resolved = report.hypotheses.filter((h) => h.state !== "open").length;
  const { evidence } = report;

  return (
    <div className="mx-auto w-full max-w-page px-8 py-6">
      <header className="mb-6 flex items-center gap-3">
        <h1 className="m-0 min-w-0 flex-1 truncate text-2xl font-semibold tracking-[-0.3px]">
          {report.headline || "Investigation"}
        </h1>
        <StatusChip status={report.status} />
      </header>

      {report.rootCause.summary && (
        <section className="mb-7">
          <SectionHeading>Root cause</SectionHeading>
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
        <section className="mb-7">
          <SectionHeading>
            Hypotheses · {resolved} of {report.hypotheses.length} resolved
          </SectionHeading>
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
                <p className="m-0 mt-1 text-sm">
                  {h.statement}
                  <CitationChips ids={h.evidenceIds} evidence={evidence} />
                </p>
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

      {evidence.length > 0 && (
        <section className="mb-7">
          <SectionHeading>Evidence</SectionHeading>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {evidence.map((item, index) => (
              <li
                key={item.id}
                id={`evidence-${item.id}`}
                className="scroll-mt-4 rounded-lg border border-border bg-card px-4 py-3"
              >
                <div className="flex items-baseline gap-2">
                  <span className="rounded-full bg-accent-tint px-1.5 py-px text-[10px] font-semibold text-run">
                    e{index + 1}
                  </span>
                  <span className="text-xs font-medium text-muted-foreground">
                    {item.toolName}
                  </span>
                </div>
                <p className="m-0 mt-1 text-sm">{item.summary}</p>
                {item.chartSnapshot && (
                  <EvidenceChart snapshot={item.chartSnapshot} />
                )}
                {item.changesSnapshot && (
                  <ChangesList snapshot={item.changesSnapshot} />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {report.proposedFix.summary && (
        <section className="mb-7">
          <SectionHeading>Proposed fix</SectionHeading>
          <p className="m-0 text-sm font-medium">
            {report.proposedFix.summary}
            <CitationChips
              ids={report.proposedFix.evidenceIds}
              evidence={evidence}
            />
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
