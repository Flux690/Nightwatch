import { useState } from "react";
import type {
  ChangesSnapshot,
  ChartSnapshot,
  EvidenceItem,
  RemediationActionRecord,
  Report,
  ReportStatus,
} from "@nightwarden/shared";
import { cn } from "@/lib/utils";
import { StatusText } from "@/components/ui/status";
import { ACTION_LABEL, ACTION_TONE } from "@/lib/remediationStatus";

// The investigation report artifact rendered in the main area, filling in live
// as the agent calls UpdateReport. Snapshots are frozen into the report, so
// evidence renders forever - nothing here re-queries a data source.

// A dot and a word, under the title. A pill floating at the top right reads as
// a badge to be glanced at; the state of an investigation is part of its
// heading, not decoration beside it.
const STATUS_VIEW: Record<ReportStatus, { label: string; dot: string }> = {
  investigation_incomplete: { label: "Investigating", dot: "bg-run" },
  root_cause_identified: { label: "Root cause identified", dot: "bg-ok" },
  inconclusive: { label: "Inconclusive", dot: "bg-border-strong" },
};

function StatusLine({ status }: { status: ReportStatus }): React.JSX.Element {
  const view = STATUS_VIEW[status];
  return (
    <span className="inline-flex items-center gap-2">
      <span
        aria-hidden="true"
        className={cn("size-1.5 shrink-0 rounded-full", view.dot)}
      />
      {view.label}
    </span>
  );
}

/* Numbered citation references: click scrolls to the cited evidence entry. The
   number is the entry's position in the evidence section, so reference and
   entry always agree. Typographic rather than a chip, so a sentence with three
   citations still reads as a sentence. */
function CitationRefs({
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
    <span className="ml-1 inline-flex gap-1">
      {cited.map(({ id, index }) => (
        <button
          key={id}
          type="button"
          aria-label={`Show evidence ${index + 1}`}
          className="font-mono text-sm text-run underline decoration-accent-wash underline-offset-2 transition-colors hover:decoration-run"
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
  const [hover, setHover] = useState<number | null>(null);
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
      <div className="relative">
        <svg
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          role="img"
          aria-label={seriesLabel}
          className="w-full rounded-md border border-border bg-background"
          onPointerMove={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            const at = ((e.clientX - box.left) / box.width) * CHART_W;
            let nearest = 0;
            for (let i = 1; i < points.length; i++) {
              if (Math.abs(x(i) - at) < Math.abs(x(nearest) - at)) nearest = i;
            }
            setHover(nearest);
          }}
          onPointerLeave={() => setHover(null)}
        >
          <polygon points={area} className="fill-run-tint" />
          <polyline
            points={line}
            className="stroke-run fill-none"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {hover !== null && (
            <g>
              <line
                x1={x(hover)}
                x2={x(hover)}
                y1={CHART_PAD}
                y2={CHART_H - CHART_PAD}
                className="stroke-border-strong"
                strokeWidth={1}
                strokeDasharray="3 3"
              />
              {/* Ringed against the surface so the marker reads on the fill. */}
              <circle
                cx={x(hover)}
                cy={y(values[hover]!)}
                r={4.5}
                className="fill-run stroke-background"
                strokeWidth={2}
              />
            </g>
          )}
        </svg>
        {hover !== null && (
          <div
            className="pointer-events-none absolute -translate-x-1/2 -translate-y-full rounded-md border border-border-strong bg-card px-2 py-1 font-mono text-sm whitespace-nowrap shadow-raised"
            style={{
              left: `${(x(hover) / CHART_W) * 100}%`,
              top: `${(y(values[hover]!) / CHART_H) * 100}%`,
            }}
          >
            {compact.format(values[hover]!)} · {timeLabel(points[hover]![0])}
          </div>
        )}
      </div>
      <figcaption className="mt-1.5 flex flex-wrap justify-between gap-2 text-sm text-muted-foreground">
        <span className="min-w-0">{seriesLabel}</span>
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
          <span className="shrink-0 text-sm text-muted-foreground">
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

export function ReportPanel({
  report,
  actions,
}: {
  report: Report;
  actions: RemediationActionRecord[];
}): React.JSX.Element {
  const resolved = report.hypotheses.filter((h) => h.state !== "open").length;
  const { evidence } = report;

  return (
    <div className="mx-auto w-full max-w-page px-8 py-6">
      <header className="mb-6">
        <h1 className="m-0 text-2xl leading-snug font-semibold tracking-[-0.3px]">
          {report.headline || "Investigation"}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <StatusLine status={report.status} />
        </div>
      </header>

      {report.rootCause.summary && (
        <section className="mt-6 border-t border-border pt-6">
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
        <section className="mt-6 border-t border-border pt-6">
          <SectionHeading>
            Hypotheses · {resolved} of {report.hypotheses.length} resolved
          </SectionHeading>
          <ul className="m-0 flex list-none flex-col gap-4 p-0">
            {report.hypotheses.map((h) => (
              <li key={h.id}>
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "text-sm font-semibold uppercase tracking-[0.05em]",
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
                  <span className="text-sm text-ink-subtle">
                    {h.confidence} confidence
                  </span>
                </div>
                <p className="m-0 mt-1 text-sm">
                  {h.statement}
                  <CitationRefs ids={h.evidenceIds} evidence={evidence} />
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
        <section className="mt-6 border-t border-border pt-6">
          <SectionHeading>Evidence</SectionHeading>
          <ul className="m-0 flex list-none flex-col gap-5 p-0">
            {evidence.map((item, index) => (
              <li
                key={item.id}
                id={`evidence-${item.id}`}
                className="scroll-mt-4"
              >
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-sm font-semibold text-run">
                    e{index + 1}
                  </span>
                  <span className="min-w-0 font-mono text-sm text-ink-subtle">
                    {item.toolName}
                  </span>
                  {/* Closes the loop: the citation names a claim, this reaches
                      the call that produced it. */}
                  {item.toolUseId !== "" && (
                    <button
                      type="button"
                      className="ml-auto shrink-0 text-sm text-ink-subtle underline decoration-border underline-offset-2 hover:text-run hover:decoration-run"
                      onClick={() =>
                        document
                          .getElementById(`tool-${item.toolUseId}`)
                          ?.scrollIntoView({
                            behavior: "smooth",
                            block: "center",
                          })
                      }
                    >
                      Show in transcript
                    </button>
                  )}
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

      {report.recommendedFix.summary && (
        <section className="mt-6 border-t border-border pt-6">
          <SectionHeading>Recommended fix</SectionHeading>
          <p className="m-0 text-sm font-medium">
            {report.recommendedFix.summary}
            <CitationRefs
              ids={report.recommendedFix.evidenceIds}
              evidence={evidence}
            />
          </p>
        </section>
      )}

      {actions.length > 0 && (
        <section className="mt-6 border-t border-border pt-6">
          <SectionHeading>Actions taken</SectionHeading>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {actions.map((action) => (
              <li key={action.toolUseId} className="flex items-baseline gap-2">
                <StatusText tone={ACTION_TONE[action.status]}>
                  {ACTION_LABEL[action.status]}
                </StatusText>
                <span className="min-w-0 flex-1 truncate font-mono text-sm">
                  {action.toolName}
                  {action.serviceIdentityKey ? (
                    <span className="text-muted-foreground">
                      {" "}
                      {action.serviceIdentityKey}
                    </span>
                  ) : null}
                </span>
                {action.resolvedBy && (
                  <span className="shrink-0 text-sm text-ink-subtle">
                    {action.status === "rejected" ? "declined" : "approved"} by{" "}
                    {action.resolvedBy}
                  </span>
                )}
              </li>
            ))}
          </ul>
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
