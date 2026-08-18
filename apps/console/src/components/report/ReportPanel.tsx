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
import { rankHypotheses } from "@nightwarden/shared";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { StatusText, type StatusTone } from "@/components/ui/status";
import { revealToolCall } from "@/components/transcript/revealToolCall";
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

function SectionHeading({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <h2 className="mb-2 font-mono text-xs font-medium uppercase tracking-[0.06em] text-muted-foreground">
      {children}
    </h2>
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
    <section className="mb-12">
      <SectionHeading>{alerts.length > 1 ? "Alerts" : "Alert"}</SectionHeading>
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {alerts.map(({ alert, clearedAt }) => (
          <li key={`${alert.sourceAlertId}-${alert.firedAt}`}>
            <div className="flex items-baseline gap-2">
              {alert.severity === "critical" && (
                <span className="text-sm font-semibold text-fail">
                  Critical
                </span>
              )}
              <span className="text-base font-medium">{alert.alertType}</span>
              {clearedAt !== null && (
                <span className="text-sm text-ok">Recovered</span>
              )}
            </div>
            <p className="m-0 mt-1 text-sm text-muted-foreground">
              {Object.entries(alert.labels)
                .map(([k, v]) => `${k}=${v}`)
                .join(", ") || "no labels"}
            </p>
            <p className="m-0 mt-1 text-sm text-ink-subtle">
              Fired {new Date(alert.firedAt).toLocaleString()}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

// Absence is the signal: a claim the ledger cannot back carries no marker, and
// no warning badge either, because a badge that appears often gets ignored.
function ConvictionMark({
  conviction,
}: {
  conviction: Conviction | undefined;
}): React.JSX.Element | null {
  if (conviction === undefined) return null;
  return <span className="text-sm text-ink-subtle">{conviction}</span>;
}

function clockOf(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? iso
    : at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/* The model's entries and the system's, in one order. Every released write is
   contributed here rather than left to the model to list, so an action cannot
   be missing from a timeline the model did not author in full. */
function mergedTimeline(
  written: TimelineEntry[],
  decisions: GatedCall[],
): TimelineEntry[] {
  const actions: TimelineEntry[] = decisions.map((call) => ({
    at: call.at,
    what: call.toolName,
    action: {
      toolName: call.toolName,
      target: call.target,
      decision: call.decision,
      ...(call.outcome !== undefined && { outcome: call.outcome }),
    },
  }));
  return [...written, ...actions].sort((a, b) => a.at.localeCompare(b.at));
}

/* The call behind a moment, as a chip that reaches it. The model has been paying
   tokens on this id since the schema first asked for one; until now nothing
   drew it, so a timeline entry claimed a fact and hid what showed it. */
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
      variant="link"
      className="h-auto shrink-0 p-0 font-mono text-sm text-ink-subtle"
      onClick={() => revealToolCall(cited.toolUseId)}
    >
      {cited.toolName}
    </Button>
  );
}

function TimelineRow({
  entry,
  evidence,
}: {
  entry: TimelineEntry;
  evidence: Map<string, ResolvedEvidence>;
}): React.JSX.Element {
  const action = entry.action;
  return (
    <li className="flex gap-3">
      <span className="shrink-0 tabular-nums text-sm text-ink-subtle">
        {clockOf(entry.at)}
      </span>
      {action === undefined ? (
        <>
          <span className="min-w-0 flex-1 text-sm">{entry.what}</span>
          <EvidenceChip entry={entry} evidence={evidence} />
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

function Prose({
  heading,
  children,
}: {
  heading: string;
  children: string;
}): React.JSX.Element | null {
  if (children.trim() === "") return null;
  return (
    <section className="mt-12">
      <SectionHeading>{heading}</SectionHeading>
      <p className="m-0 text-sm">{children}</p>
    </section>
  );
}

export function ReportPanel({
  report,
  decisions,
  evidence,
  conviction,
  alerts,
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
}): React.JSX.Element {
  const alert = alerts[0]?.alert ?? null;
  if (report === null) {
    return (
      <div className="mx-auto w-full max-w-report px-8 py-6">
        <AlertBand alerts={alerts} />
        <header>
          <h1 className="m-0 text-2xl leading-snug font-semibold tracking-[-0.3px]">
            Investigation
          </h1>
          <p className="m-0 mt-2 text-sm text-muted-foreground">
            The agent has not recorded a finding yet.
          </p>
        </header>
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
  const timeline = mergedTimeline(submitted?.timeline ?? [], decisions);

  // Drawn in full once per report; later citations are named and linked. Filled
  // while rendering, so the first drawing is the one the reader can scroll back to.
  const drawn = new Set<string>();
  const citedUnder = (ids: string[]): React.JSX.Element | null => {
    const cited = [...new Set(ids)].flatMap((id) => byId.get(id) ?? []);
    if (cited.length === 0) return null;
    return (
      <div className="mt-2">
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

  // The verdict label is dropped under "Ruled out" - the heading says it. The
  // conviction mark is not: the reader who doubts the verdict needs it most.
  const claimRow = (h: Hypothesis, withVerdict: boolean): React.JSX.Element => (
    <li key={h.id}>
      <div className="flex items-baseline gap-2">
        {withVerdict && (
          <span className={cn("text-sm", VERDICT_VIEW[h.verdict].className)}>
            {VERDICT_VIEW[h.verdict].label}
          </span>
        )}
        <ConvictionMark conviction={conviction[h.id]} />
      </div>
      <p className="m-0 mt-1 text-sm font-medium">{h.statement}</p>
      {h.finding && (
        <p className="m-0 mt-1 text-sm text-muted-foreground">{h.finding}</p>
      )}
      {citedUnder(h.evidenceIds)}
    </li>
  );

  return (
    <div className="mx-auto w-full max-w-report px-8 py-6">
      <AlertBand alerts={alerts} />
      <header>
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
          <p className="m-0 mt-2 text-lg font-medium">
            {findings[0].statement}
          </p>
        )}
        {submitted?.headline !== undefined && (
          <p className="m-0 mt-2 text-base text-muted-foreground">
            {submitted.summary}
          </p>
        )}
        {submitted?.affected !== undefined && (
          <p className="m-0 mt-2 text-sm text-ink-subtle">
            Affected: {submitted.affected}
          </p>
        )}
      </header>

      {timeline.length > 0 && (
        <section className="mt-12">
          <SectionHeading>Timeline</SectionHeading>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {timeline.map((entry, i) => (
              <TimelineRow
                key={`${entry.at}-${i}`}
                entry={entry}
                evidence={byId}
              />
            ))}
          </ul>
        </section>
      )}

      {submitted !== null && (
        <>
          <Prose heading="Impact">{submitted.impact}</Prose>
          <Prose heading="Recommendation">{submitted.recommendation}</Prose>
        </>
      )}

      {findings.length > 0 && (
        <section className="mt-12">
          <SectionHeading>Findings</SectionHeading>
          <ul className="m-0 flex list-none flex-col gap-6 p-0">
            {findings.map((h) => claimRow(h, true))}
          </ul>
        </section>
      )}

      {ruledOut.length > 0 && (
        <section className="mt-12">
          {/* No verdict label on these rows: the heading already says it, and
              repeating "Disproven" down the column says nothing new. */}
          <SectionHeading>Ruled out</SectionHeading>
          <ul className="m-0 flex list-none flex-col gap-6 p-0">
            {ruledOut.map((h) => claimRow(h, false))}
          </ul>
        </section>
      )}
    </div>
  );
}
