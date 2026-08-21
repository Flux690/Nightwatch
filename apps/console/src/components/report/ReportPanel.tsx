import type {
  Conviction,
  GatedCall,
  Hypothesis,
  SessionAlert,
  Report,
  ReportConviction,
  ResolvedEvidence,
  TimelineEntry,
  Verdict,
} from "@nightwarden/shared";
import { leadingHypothesis, rankHypotheses } from "@nightwarden/shared";
import { cn } from "@/lib/utils";
import { StatusText, type StatusTone } from "@/components/ui/status";
import { elapsed } from "@/lib/time";
import { CitationChip } from "./CitationChip.js";
import { Evidence } from "./Evidence.js";

/* Two authors on one page: the prose at the top is the model's, everything
   beneath it - what backs a claim, how well, what actually ran - is the system
   answering for itself. The headings are nominal: there is no "we" here.

   Three axes, one meaning each. SIZE is level: 24 the headline, 18 a section,
   16 the deck and a claim, 14 prose, 12 a caption. WEIGHT is semibold for a
   heading, medium for a claim, regular for everything else. COLOUR says what a
   thing is rather than how loud it is: anything written in sentences for a
   person to read takes full ink, and muted is for what is not prose - labels,
   counts, captions, timestamps, log lines. Dimming an explanation because it
   sits under something else is a third differentiator doing a job the first
   two have already done. */

/* Colour marks the two verdicts that change what a user does next. The other
   two standing verdicts are full ink: a symptom is a finding the run stands
   behind, and setting it back said it mattered less than it does. Only what the
   run discarded is muted. */
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

function SectionHeading({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <h2 className="mb-3 text-lg leading-snug font-semibold tracking-[-0.1px]">
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
      <SectionHeading>{heading}</SectionHeading>
      {children}
    </section>
  );
}

/* What the user did, and what came of it. Three words because there are
   three outcomes worth telling apart: it ran, they said no, or it broke. Who
   decided is not shown - there is one user, and the record is theirs. */
function decisionView(call: {
  decision: "approved" | "rejected";
  toolOutcome?: string;
}): { label: string; tone: StatusTone } {
  if (call.decision === "rejected") return { label: "Declined", tone: "muted" };
  return call.toolOutcome === "system" || call.toolOutcome === "retryable"
    ? { label: "Failed", tone: "fail" }
    : { label: "Ran", tone: "ok" };
}

// What woke the user, read from the alerts themselves rather than from the
// opening message, which is written for the model. Rendered before the agent has
// said anything, so the first thing on screen at 02:14 is true.
function AlertBand({
  alerts,
}: {
  alerts: SessionAlert[];
}): React.JSX.Element | null {
  if (alerts.length === 0) return null;
  return (
    <section className="border-b border-border pb-4">
      <SectionHeading>{alerts.length > 1 ? "Alerts" : "Alert"}</SectionHeading>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {alerts.map(({ alert, clearedAt }) => (
          <li key={`${alert.sourceAlertId}-${alert.firedAt}`}>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              {alert.severity === "critical" && (
                <span className="text-sm text-fail">Critical</span>
              )}
              <span className="text-base font-medium">{alert.alertType}</span>
              <span className="ml-auto flex shrink-0 items-baseline gap-2 text-sm">
                {clearedAt !== null && (
                  <span className="text-ok">Recovered</span>
                )}
                <span className="tabular-nums text-ink-subtle">
                  {clockOf(clearedAt ?? alert.firedAt)}
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

function clockOf(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? iso
    : at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/* The model's entries and the system's, in one order, split once where the
   alert fired. Every released write is contributed here rather than left to the
   model to list, so an action cannot be missing from a timeline it did not
   author in full - and it appears here alone, never as a second list. */
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
        ...(call.toolOutcome !== undefined && {
          toolOutcome: call.toolOutcome,
        }),
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
  return <CitationChip toolUseId={cited.toolUseId} toolName={cited.toolName} />;
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
      {clockOf(row.at)}
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

/* What the system can say about the run without the model's help, as a
   sentence rather than a row of tiles: this page has no boxes to spend, and a
   clause that has no answer is left out rather than printed empty. */
function Facts({
  report,
  conviction,
  evidence,
  decisions,
  span,
}: {
  report: Report;
  conviction: ReportConviction;
  evidence: ResolvedEvidence[];
  decisions: GatedCall[];
  span: string | null;
}): React.JSX.Element | null {
  const leading = leadingHypothesis(report.hypotheses);
  const ruledOut = report.hypotheses.filter((h) => h.verdict === "disproven");
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
  if (report.hypotheses.length > 0) {
    clauses.push(
      <>
        <b className="font-medium text-foreground">
          {report.hypotheses.length}
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
  report,
  decisions,
  evidence,
  conviction,
  alerts,
  createdAt = null,
  lastActivityAt = null,
}: {
  // Null until the agent records its first finding. The investigation view is
  // drawn from the session, not from this, so the panel outlives its absence.
  report: Report | null;
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

  if (report === null) {
    return (
      <div className="mx-auto w-full max-w-report px-8 py-6">
        <div className="max-w-measure">
          <AlertBand alerts={alerts} />
          <h1 className="m-0 mt-8 text-2xl leading-snug font-semibold tracking-[-0.3px]">
            Investigation
          </h1>
          <p className="m-0 mt-3 text-sm text-muted-foreground">
            The agent has not recorded a finding yet.
          </p>
        </div>
      </div>
    );
  }

  const byId = new Map(evidence.map((e) => [e.toolUseId, e]));
  // Coalesced rather than read straight: a record stored before the write-up
  // existed carries no key at all, and an absent one must read as "not written
  // up yet", not as an object to reach into.
  const submitted = report.submitted ?? null;
  const ranked = rankHypotheses(report.hypotheses);
  const findings = ranked.filter((h) => h.verdict !== "disproven");
  const ruledOut = ranked.filter((h) => h.verdict === "disproven");
  const rows = timelineRows(
    submitted?.timeline ?? [],
    decisions,
    alert?.firedAt ?? null,
  );
  const approved = decisions.filter((call) => call.decision === "approved");

  /* Drawn once per report: a second claim citing the same call names it in its
     own sources row and redraws nothing, because one measurement read twice
     down the page reads as two. */
  const drawn = new Set<string>();
  const evidenceUnder = (ids: string[]): React.JSX.Element[] => {
    const cited = [...new Set(ids)].flatMap((id) => byId.get(id) ?? []);
    return cited.map((entry) => {
      const repeat = drawn.has(entry.toolUseId);
      drawn.add(entry.toolUseId);
      return (
        <Evidence
          key={entry.toolUseId}
          entry={entry}
          alert={alert}
          repeat={repeat}
        />
      );
    });
  };

  /* Where footnotes go: at the foot of what they back, naming every call the
     claim rests on. One row rather than a control hung off each drawing, which
     is what left a chip stranded whenever a call named no target. */
  const sourcesUnder = (ids: string[]): React.JSX.Element | null => {
    const cited = [...new Set(ids)].flatMap((id) => byId.get(id) ?? []);
    if (cited.length === 0) return null;
    return (
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <span className="mr-1 font-mono text-xs font-medium uppercase tracking-[0.06em] text-muted-foreground">
          Sources
        </span>
        {cited.map((entry) => (
          <CitationChip
            key={entry.toolUseId}
            toolUseId={entry.toolUseId}
            toolName={entry.toolName}
          />
        ))}
      </div>
    );
  };

  /* One column, read downward: what it is, what it says, why, then what backs
     it. A margin column for two short words spent a sixth of the page on them
     and squeezed the statement into the rest. */
  const claim = (h: Hypothesis): React.JSX.Element => (
    <li
      key={h.id}
      className="border-t border-border py-6 first:border-t-0 first:pt-0"
    >
      <div className="flex items-baseline gap-3">
        <span className={cn("text-sm", VERDICT_VIEW[h.verdict].className)}>
          {VERDICT_VIEW[h.verdict].label}
        </span>
        {/* Absence is the signal: a claim the ledger cannot back carries no
            marker, and no warning badge either. */}
        {conviction[h.id] !== undefined && (
          <span className="text-sm text-ink-subtle">
            {conviction[h.id] as Conviction}
          </span>
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
            sentence that is the answer, and the paragraph that expands it. A
            report written before `headline` existed has only the summary, so
            that leads instead; before any write-up, the leading claim does. */}
        <h1 className="m-0 text-2xl leading-snug font-semibold tracking-[-0.3px]">
          {submitted === null
            ? "Investigation"
            : (submitted.headline ?? submitted.summary)}
        </h1>
        {submitted === null && findings[0] !== undefined && (
          <p className="m-0 mt-3 text-lg font-medium">
            {findings[0].statement}
          </p>
        )}
        {/* The one block held to a reading measure: it is the longest passage
            on the page, and the only one with enough lines for a return sweep
            to lose your place in. */}
        {submitted?.headline !== undefined && (
          <p className="m-0 mt-3 max-w-measure text-base leading-relaxed">
            {submitted.summary}
          </p>
        )}
        {submitted?.affected !== undefined && (
          <p className="m-0 mt-3 text-sm text-ink-subtle">
            Affected: {submitted.affected}
          </p>
        )}
      </header>

      <Facts
        report={report}
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
          <SectionHeading>What happened</SectionHeading>
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
          <SectionHeading>Impact</SectionHeading>
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
          <SectionHeading>Ruled out</SectionHeading>
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
