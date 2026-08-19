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
import { Button } from "@/components/ui/button";
import { StatusText, type StatusTone } from "@/components/ui/status";
import { revealToolCall } from "@/components/transcript/revealToolCall";
import { elapsed } from "@/lib/time";
import { Evidence } from "./Evidence.js";

/* Two authors on one page: the prose at the top is the model's, everything
   beneath it - what backs a claim, how well, what actually ran - is the system
   answering for itself. The headings are nominal: there is no "we" here. */

// Colour is kept for the two verdicts that change what a user does next.
// The rest are set in the ink hierarchy: a page where every label shouts says
// nothing about which one matters.
const VERDICT_VIEW: Record<Verdict, { label: string; className: string }> = {
  root_cause: { label: "Root cause", className: "text-ok" },
  trigger: { label: "Trigger", className: "text-ok" },
  contributing_factor: {
    label: "Contributing factor",
    className: "text-muted-foreground",
  },
  symptom: { label: "Symptom", className: "text-muted-foreground" },
  disproven: { label: "Disproven", className: "text-muted-foreground" },
};

const TIMELINE_ID = "report-timeline";

function SectionHeading({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <h2 className="mb-3 font-mono text-xs font-medium uppercase tracking-[0.06em] text-muted-foreground">
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
    <section className="mt-12 border-t border-border pt-8">
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
  outcome?: string;
}): { label: string; tone: StatusTone } {
  if (call.decision === "rejected") return { label: "Declined", tone: "muted" };
  return call.outcome === "system" || call.outcome === "retryable"
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
                <span className="text-sm font-semibold text-fail">
                  Critical
                </span>
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
        ...(call.outcome !== undefined && { outcome: call.outcome }),
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

/* The call behind a moment, as a chip that reaches it. A bordered shape rather
   than cobalt, which the system spends on hover alone. */
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
    <Button
      variant="outline"
      size="xs"
      className="shrink-0 rounded-full font-mono text-ink-subtle"
      onClick={() => revealToolCall(cited.toolUseId)}
    >
      {cited.toolName}
    </Button>
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
    <p className="m-0 mt-8 border-t border-border pt-4 text-sm leading-loose text-muted-foreground">
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

  // Drawn in full once per report; later citations are named and linked. Filled
  // while rendering, so the first drawing is the one the reader can scroll back to.
  const drawn = new Set<string>();
  const citedUnder = (ids: string[]): React.JSX.Element | null => {
    const cited = [...new Set(ids)].flatMap((id) => byId.get(id) ?? []);
    if (cited.length === 0) return null;
    return (
      <div className="mt-3">
        {cited.map((entry) => {
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
        })}
      </div>
    );
  };

  /* The verdict hangs in the margin so every statement starts at one left edge
     down the page. No fold below it: the console's own floor is 768, which
     still leaves the claim more room than a line of prose wants. */
  const claim = (h: Hypothesis): React.JSX.Element => (
    <li
      key={h.id}
      className="grid grid-cols-[9rem_1fr] gap-x-6 border-t border-border py-6 first:border-t-0 first:pt-0"
    >
      <div className="flex flex-col gap-1">
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
      <div className="min-w-0">
        <p className="m-0 text-base leading-snug font-medium">{h.statement}</p>
        {h.finding && (
          <p className="m-0 mt-2 text-sm leading-relaxed text-muted-foreground">
            {h.finding}
          </p>
        )}
        {citedUnder(h.evidenceIds)}
      </div>
    </li>
  );

  return (
    <div className="mx-auto w-full max-w-report px-8 py-6">
      <div className="max-w-measure">
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
          {submitted?.headline !== undefined && (
            <p className="m-0 mt-3 text-base leading-relaxed text-muted-foreground">
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
            <div className="border-l-2 border-border-strong pl-4">
              <p className="m-0 text-base leading-relaxed">
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
            className="mt-12 scroll-mt-6 border-t border-border pt-8"
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
                  <span className="min-w-0 flex-1 text-sm">{h.statement}</span>
                  {h.finding && (
                    <span className="text-sm text-muted-foreground">
                      {h.finding}
                    </span>
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
    </div>
  );
}
