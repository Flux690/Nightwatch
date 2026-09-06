// Three axes, one meaning each: size is level, weight marks a heading alone,
// and colour says what a thing is rather than how loud.

import type {
  Conviction,
  GatedCall,
  Hypothesis,
  SessionAlert,
  InvestigationRecord,
  ReportConviction,
  ResolvedEvidence,
  TimelineEntry,
  Verdict,
} from "@nightwarden/shared";
import {
  leadingHypothesis,
  rankHypotheses,
  supersededIds,
} from "@nightwarden/shared";
import { cn } from "@/shared/lib/utils";
import { SECTION_HEADING } from "@/shared/ui/Page";
import { StatusText, type StatusTone } from "@/shared/ui/status";
import { clock, elapsed, zoneName } from "@/shared/lib/time";
import { CitationChip } from "./CitationChip.js";
import { Evidence } from "./Evidence.js";

// Colour marks the two verdicts that change what a user does next. The other
// standing verdicts take full ink; only what the run discarded is muted.
const VERDICT_VIEW: Record<Verdict, { label: string; className: string }> = {
  root_cause: { label: "Root cause", className: "text-ok" },
  trigger: { label: "Trigger", className: "text-ok" },
  contributing_factor: {
    label: "Contributing factor",
    className: "text-foreground",
  },
  symptom: { label: "Symptom", className: "text-foreground" },
  disproven: { label: "Disproven", className: "text-muted-foreground" },
};

const TIMELINE_ID = "report-timeline";

function BandHeading({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <h2 className="mb-3 text-lg leading-snug font-semibold tracking-heading">
      {children}
    </h2>
  );
}

/* Three tiers of space, so the page has a rhythm to read by: a rule with 48
   above it at a band, 32 at a section, and 8 to 12 within one. */
function Band({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="mt-8 border-t border-border pt-4">
      <BandHeading>{heading}</BandHeading>
      {children}
    </section>
  );
}

// Three words for the three outcomes worth telling apart: it ran, they said
// no, or it broke. Who decided is not shown, since there is one user.
function decisionView(call: {
  decision: "approved" | "rejected";
  isError?: boolean;
}): { label: string; tone: StatusTone } {
  if (call.decision === "rejected") return { label: "Declined", tone: "muted" };
  return call.isError === true
    ? { label: "Failed", tone: "fail" }
    : { label: "Ran", tone: "ok" };
}

// Read from the alerts themselves, not the opening message written for the
// model, so the first thing on screen at 02:14 is true.
function AlertBand({
  alerts,
}: {
  alerts: SessionAlert[];
}): React.JSX.Element | null {
  if (alerts.length === 0) return null;
  return (
    <section className="border-b border-border pb-4">
      <BandHeading>{alerts.length > 1 ? "Alerts" : "Alert"}</BandHeading>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {alerts.map(({ alert, clearedAt }) => (
          <li key={`${alert.sourceAlertId}-${alert.firedAt}`}>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              {/* The sender's own word, uncoloured. Ranking it here would show
                  a fleet labelling alerts P1 nothing at all. */}
              {alert.labels["severity"] !== undefined && (
                <span className="text-sm text-ink-subtle">
                  {alert.labels["severity"]}
                </span>
              )}
              <span className="text-base font-medium">{alert.alertType}</span>
              <span className="ml-auto flex shrink-0 items-baseline gap-2 text-sm">
                {clearedAt !== null && (
                  <span className="text-ok">Recovered</span>
                )}
                <span className="tabular-nums text-ink-subtle">
                  {clock(clearedAt ?? alert.firedAt)}
                </span>
              </span>
            </div>
            <p className="m-0 mt-1 text-sm text-muted-foreground">
              {Object.entries(alert.labels)
                .map(([k, v]) => `${k}=${v}`)
                .join(", ") || "no labels"}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

// Released writes are contributed here rather than listed by the model, so an
// action cannot be missing from a timeline it did not author.
type Row =
  | { at: string; kind: "entry"; entry: TimelineEntry }
  | { at: string; kind: "alert" };

function timelineRows(
  written: TimelineEntry[],
  decisions: GatedCall[],
  firedAt: string | null,
): Row[] {
  const entries: Row[] = written.map((entry) => ({
    at: entry.at,
    kind: "entry",
    entry,
  }));
  const actions: Row[] = decisions.map((call) => ({
    at: call.at,
    kind: "entry",
    entry: {
      at: call.at,
      what: call.toolName,
      action: {
        toolName: call.toolName,
        target: call.target,
        decision: call.decision,
        ...(call.isError === true && { isError: true }),
      },
    },
  }));
  const rows = [...entries, ...actions];
  // The rule only reads as a boundary with something on both sides of it.
  const splits =
    firedAt !== null &&
    rows.some((row) => row.at < firedAt) &&
    rows.some((row) => row.at >= firedAt);
  if (splits) rows.push({ at: firedAt, kind: "alert" });
  return rows.sort((a, b) => a.at.localeCompare(b.at));
}

// The call behind a moment, in the same chip the evidence blocks use.
function EvidenceChip({
  entry,
  evidence,
}: {
  entry: TimelineEntry;
  evidence: Map<string, ResolvedEvidence>;
}): React.JSX.Element | null {
  const cited =
    entry.evidenceId === undefined ? undefined : evidence.get(entry.evidenceId);
  if (cited === undefined) return null;
  return (
    <CitationChip toolCallId={cited.toolCallId} toolName={cited.toolName} />
  );
}

// Every row on one grid, the alert's included: one time column, one size, one
// alignment, so nothing on it reads as a different kind of thing.
function TimelineRow({
  row,
  evidence,
}: {
  row: Row;
  evidence: Map<string, ResolvedEvidence>;
}): React.JSX.Element {
  const time = (
    <span className="shrink-0 tabular-nums text-sm text-ink-subtle">
      {clock(row.at)}
    </span>
  );

  if (row.kind === "alert") {
    return (
      <li className="flex items-center gap-3 py-2">
        {time}
        <span className="shrink-0 text-sm text-muted-foreground">
          the alert fired
        </span>
        <span aria-hidden className="h-px min-w-0 flex-1 bg-border-strong" />
      </li>
    );
  }

  const action = row.entry.action;
  return (
    <li className="flex items-baseline gap-3">
      {time}
      {action === undefined ? (
        <>
          <span className="min-w-0 flex-1 text-sm">{row.entry.what}</span>
          <EvidenceChip entry={row.entry} evidence={evidence} />
        </>
      ) : (
        <span className="flex min-w-0 items-baseline gap-2">
          <StatusText tone={decisionView(action).tone}>
            {decisionView(action).label}
          </StatusText>
          <span className="min-w-0 truncate font-mono text-sm">
            {action.toolName}
            {action.target !== null && (
              <span className="text-muted-foreground"> {action.target}</span>
            )}
          </span>
        </span>
      )}
    </li>
  );
}

// A sentence rather than a row of tiles, and a clause with no answer is left
// out rather than printed empty.
function Facts({
  record,
  conviction,
  evidence,
  decisions,
  span,
}: {
  record: InvestigationRecord;
  conviction: ReportConviction;
  evidence: ResolvedEvidence[];
  decisions: GatedCall[];
  span: string | null;
}): React.JSX.Element | null {
  const leading = leadingHypothesis(record.hypotheses);
  const ruledOut = record.hypotheses.filter((h) => h.verdict === "disproven");
  const approved = decisions.filter((call) => call.decision === "approved");

  const clauses: React.ReactNode[] = [];
  if (leading !== null) {
    const backing = conviction[leading.id];
    clauses.push(
      <>
        Leading verdict{" "}
        <b className="font-medium text-foreground">
          {VERDICT_VIEW[leading.verdict].label.toLowerCase()}
        </b>
        {backing !== undefined && (
          <>
            , backed as <b className="font-medium text-foreground">{backing}</b>
          </>
        )}
      </>,
    );
  }
  if (record.hypotheses.length > 0) {
    clauses.push(
      <>
        <b className="font-medium text-foreground">
          {record.hypotheses.length}
        </b>{" "}
        tested, <b className="font-medium text-foreground">{ruledOut.length}</b>{" "}
        ruled out
      </>,
    );
  }
  if (evidence.length > 0) {
    clauses.push(
      <>
        <b className="font-medium text-foreground">{evidence.length}</b> calls
        cited
      </>,
    );
  }
  if (approved.length > 0) {
    clauses.push(
      <>
        <b className="font-medium text-foreground">{approved.length}</b>{" "}
        {approved.length === 1 ? "write" : "writes"} you approved
      </>,
    );
  }
  if (span !== null) {
    clauses.push(
      <>
        <b className="font-medium text-foreground">{span}</b> end to end
      </>,
    );
  }
  if (clauses.length === 0) return null;

  return (
    <p className="m-0 mt-8 text-sm leading-loose text-muted-foreground">
      {clauses.map((clause, at) => (
        <span key={at}>
          {at > 0 && " · "}
          {clause}
        </span>
      ))}
    </p>
  );
}

export function ReportPanel({
  record,
  decisions,
  evidence,
  conviction,
  alerts,
  createdAt = null,
  lastActivityAt = null,
}: {
  // Null until the agent records its first finding. The investigation view is
  // drawn from the session, not from this, so the panel outlives its absence.
  record: InvestigationRecord | null;
  // Every call the user had to release, and which way they went.
  decisions: GatedCall[];
  // The cited calls, resolved by the API against the transcript.
  evidence: ResolvedEvidence[];
  conviction: ReportConviction;
  // In arrival order. The band shows them all; the evidence plots need just one
  // to draw the alert marker against.
  alerts: SessionAlert[];
  // What the run is timed between. Absent on a session still loading.
  createdAt?: string | null;
  lastActivityAt?: string | null;
}): React.JSX.Element {
  const alert = alerts[0]?.alert ?? null;
  const span =
    createdAt !== null && lastActivityAt !== null
      ? elapsed(createdAt, lastActivityAt)
      : null;

  if (record === null) {
    return (
      <div className="mx-auto w-full max-w-report px-8 py-6">
        <div className="max-w-measure">
          <AlertBand alerts={alerts} />
          <h1 className="m-0 mt-8 text-2xl leading-snug font-semibold tracking-title">
            Investigation
          </h1>
          <p className="m-0 mt-3 text-sm text-muted-foreground">
            The agent has not recorded a finding yet.
          </p>
        </div>
      </div>
    );
  }

  const byId = new Map(evidence.map((e) => [e.evidenceId, e]));
  // Null until the run reaches its report turn, which reads as "not written
  // up yet" rather than as an empty write-up.
  const submitted = record.report ?? null;
  const ranked = rankHypotheses(record.hypotheses);
  const replaced = supersededIds(record.hypotheses);
  // Sorted below the claims that still stand, so the leading one reads first
  // however many times the run revised its way to it.
  const findings = ranked
    .filter((h) => h.verdict !== "disproven")
    .sort((a, b) => Number(replaced.has(a.id)) - Number(replaced.has(b.id)));
  const ruledOut = ranked.filter((h) => h.verdict === "disproven");
  const rows = timelineRows(
    submitted?.timeline ?? [],
    decisions,
    alert?.firedAt ?? null,
  );
  const approved = decisions.filter((call) => call.decision === "approved");

  /* Drawn once per report: a second claim citing the same call names it and
     redraws nothing, because one measurement read twice reads as two. */
  const drawn = new Set<string>();
  const evidenceUnder = (ids: string[]): React.JSX.Element[] => {
    const cited = [...new Set(ids)].flatMap((id) => byId.get(id) ?? []);
    return cited.map((entry) => {
      const repeat = drawn.has(entry.toolCallId);
      drawn.add(entry.toolCallId);
      return (
        <Evidence
          key={entry.toolCallId}
          entry={entry}
          alert={alert}
          repeat={repeat}
        />
      );
    });
  };

  // One row for the whole claim, so a call naming no target still has somewhere
  // to render.
  const sourcesUnder = (ids: string[]): React.JSX.Element | null => {
    const cited = [...new Set(ids)].flatMap((id) => byId.get(id) ?? []);
    if (cited.length === 0) return null;
    return (
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <span className={cn("mr-1", SECTION_HEADING)}>Sources</span>
        {cited.map((entry) => (
          <CitationChip
            key={entry.toolCallId}
            toolCallId={entry.toolCallId}
            toolName={entry.toolName}
          />
        ))}
      </div>
    );
  };

  // One column read downward. A margin column for two short words spent a
  // sixth of the page on them and squeezed the statement into the rest.
  const claim = (h: Hypothesis): React.JSX.Element => (
    <li
      key={h.id}
      className="border-t border-border py-6 first:border-t-0 first:pt-0"
    >
      <div className="flex items-baseline gap-3">
        <span className={cn("text-sm", VERDICT_VIEW[h.verdict].className)}>
          {VERDICT_VIEW[h.verdict].label}
        </span>
        {/* Absence is the signal: a claim nothing can back carries no
            marker, and no warning badge either. */}
        {conviction[h.id] !== undefined && (
          <span className="text-sm text-ink-subtle">
            {conviction[h.id] as Conviction}
          </span>
        )}
        {/* Demoted, never removed: where the run changed its mind is part of
            what happened, and a claim that vanished cannot be audited. */}
        {replaced.has(h.id) && (
          <span className="text-sm text-ink-subtle">replaced</span>
        )}
      </div>
      <p className="m-0 mt-2 text-base leading-snug font-medium">
        {h.statement}
      </p>
      {h.finding && (
        <p className="m-0 mt-2 text-sm leading-relaxed">{h.finding}</p>
      )}
      {evidenceUnder(h.evidenceIds)}
      {sourcesUnder(h.evidenceIds)}
    </li>
  );

  return (
    <div className="mx-auto w-full max-w-report px-8 py-6">
      <AlertBand alerts={alerts} />

      <header className="mt-8">
        {/* Headline then deck, which is what the two fields are for: the one
            sentence that is the answer, and the paragraph that expands it.
            Before any write-up, the leading claim stands in for the headline. */}
        <h1 className="m-0 text-2xl leading-snug font-semibold tracking-title">
          {submitted === null ? "Investigation" : submitted.headline}
        </h1>
        {submitted === null && findings[0] !== undefined && (
          <p className="m-0 mt-3 text-lg font-medium">
            {findings[0].statement}
          </p>
        )}
        {/* The one block held to a reading measure: it is the longest passage
            on the page, and the only one with enough lines for a return sweep
            to lose your place in. */}
        {submitted !== null && (
          <p className="m-0 mt-3 max-w-measure text-base leading-relaxed">
            {submitted.summary}
          </p>
        )}
        {submitted !== null && (
          <p className="m-0 mt-3 text-sm text-ink-subtle">
            Affected: {submitted.affected}
          </p>
        )}
        {/* Stated once for the whole report rather than on each of its clocks.
            Every time below reads in the zone of whoever opened it, so a time
            quoted out of here means nothing without the zone beside it. */}
        <p className="m-0 mt-3 text-sm text-ink-subtle">
          Times in {zoneName()}
        </p>
      </header>

      <Facts
        record={record}
        conviction={conviction}
        evidence={evidence}
        decisions={decisions}
        span={span}
      />

      {submitted !== null && submitted.recommendation.trim() !== "" && (
        <Band heading="Recommendation">
          <div>
            <p className="m-0 text-sm leading-relaxed">
              {submitted.recommendation}
            </p>
            {/* Named once, beside what to do, and pointing at the timeline
                rather than repeating it: two lists of the same write reads as
                two writes. */}
            {approved.length > 0 && (
              <p className="m-0 mt-3 text-sm text-muted-foreground">
                <span className="text-ok">
                  {approved.length === 1
                    ? "One write you approved"
                    : `${approved.length} writes you approved`}
                </span>{" "}
                ran during this investigation.{" "}
                <a
                  href={`#${TIMELINE_ID}`}
                  className="underline decoration-border underline-offset-2 hover:text-primary-ink hover:decoration-primary-ink"
                >
                  See it on the timeline
                </a>
              </p>
            )}
          </div>
        </Band>
      )}

      {rows.length > 0 && (
        <section
          id={TIMELINE_ID}
          className="mt-8 scroll-mt-6 border-t border-border pt-4"
        >
          <BandHeading>What happened</BandHeading>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {rows.map((row, i) => (
              <TimelineRow
                key={`${row.at}-${row.kind}-${i}`}
                row={row}
                evidence={byId}
              />
            ))}
          </ul>
        </section>
      )}

      {submitted !== null && submitted.impact.trim() !== "" && (
        <section className="mt-8">
          <BandHeading>Impact</BandHeading>
          <p className="m-0 text-sm leading-relaxed">{submitted.impact}</p>
        </section>
      )}

      {findings.length > 0 && (
        <Band heading="What held up">
          <ul className="m-0 flex list-none flex-col p-0">
            {findings.map(claim)}
          </ul>
        </Band>
      )}

      {ruledOut.length > 0 && (
        <section className="mt-8">
          {/* One line each, and no evidence drawn: the reader who wants the
              proof of something the run discarded is one click from it, and
              drawing it here is where the page's length went. */}
          <BandHeading>Ruled out</BandHeading>
          <ul className="m-0 flex list-none flex-col p-0">
            {ruledOut.map((h) => (
              <li
                key={h.id}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-border py-2 first:border-t-0"
              >
                <span className="min-w-0 flex-[2] text-sm">{h.statement}</span>
                {h.finding && (
                  <span className="min-w-0 flex-1 text-sm">{h.finding}</span>
                )}
                {/* Kept, where the evidence is not: the reader who doubts a
                    ruling needs to know how well it was backed. */}
                {conviction[h.id] !== undefined && (
                  <span className="shrink-0 text-sm text-ink-subtle">
                    {conviction[h.id] as Conviction}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
