import type {
  Conviction,
  GatedCall,
  NormalizedAlert,
  SessionAlert,
  Report,
  ReportConviction,
  ResolvedEvidence,
  Verdict,
} from "@nightwarden/shared";
import { cn } from "@/lib/utils";
import { StatusText, type StatusTone } from "@/components/ui/status";
import { Evidence } from "./Evidence.js";

/* What the operator did, and what came of it. Three words because there are
   three outcomes worth telling apart: it ran, they said no, or it broke. Who
   decided is not shown - there is one operator, and the record is theirs. */
function decisionView(call: GatedCall): { label: string; tone: StatusTone } {
  if (call.decision === "rejected") return { label: "Declined", tone: "muted" };
  return call.outcome === "system" || call.outcome === "retryable"
    ? { label: "Failed", tone: "fail" }
    : { label: "Ran", tone: "ok" };
}

// The investigation report rendered in the main area. The claims are the
// model's; everything around them - the evidence, the conviction, what ran - is
// the system answering for itself.

const VERDICT_VIEW: Record<Verdict, { label: string; className: string }> = {
  root_cause: { label: "Root cause", className: "text-ok" },
  trigger: { label: "Trigger", className: "text-ok" },
  contributing_factor: { label: "Contributing factor", className: "text-wait" },
  symptom: { label: "Symptom", className: "text-muted-foreground" },
  disproven: {
    label: "Disproven",
    className: "text-muted-foreground line-through",
  },
  open: { label: "Open", className: "text-run" },
};

function SectionHeading({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <h2 className="mb-2 text-xs font-medium uppercase tracking-[0.06em] text-muted-foreground">
      {children}
    </h2>
  );
}

// What woke the operator, read from the alerts themselves rather than from the
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

function CitedEvidence({
  ids,
  evidence,
  alert,
}: {
  ids: string[];
  evidence: Map<string, ResolvedEvidence>;
  alert: NormalizedAlert | null;
}): React.JSX.Element | null {
  // A citation naming no call renders nothing at all. The claim above it stands
  // either way, so reaching past the evidence shows as a claim with none. Cited
  // once however often it is named: a repeat is the model's slip.
  const cited = [...new Set(ids)].flatMap((id) => evidence.get(id) ?? []);
  if (cited.length === 0) return null;
  return (
    <div className="mt-2">
      {cited.map((entry) => (
        <Evidence key={entry.toolUseId} entry={entry} alert={alert} />
      ))}
    </div>
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
  // Every call the operator had to release, and which way they went.
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
  // The verdict line is the root-cause hypothesis itself, not a second
  // free-text field that could disagree with it.
  const rootCause = report.hypotheses.find((h) => h.verdict === "root_cause");

  return (
    <div className="mx-auto w-full max-w-report px-8 py-6">
      <AlertBand alerts={alerts} />
      <header className="mb-6">
        <h1 className="m-0 text-2xl leading-snug font-semibold tracking-[-0.3px]">
          Investigation
        </h1>
        {rootCause !== undefined && (
          <p className="m-0 mt-2 text-lg font-medium">{rootCause.statement}</p>
        )}
      </header>

      {report.hypotheses.length > 0 && (
        <section className="mt-12">
          <SectionHeading>Hypotheses</SectionHeading>
          <ul className="m-0 flex list-none flex-col gap-6 p-0">
            {report.hypotheses.map((h) => (
              <li key={h.id}>
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "text-sm font-semibold uppercase tracking-[0.05em]",
                      VERDICT_VIEW[h.verdict].className,
                    )}
                  >
                    {VERDICT_VIEW[h.verdict].label}
                  </span>
                  <ConvictionMark conviction={conviction[h.id]} />
                </div>
                <p className="m-0 mt-1 text-sm">{h.statement}</p>
                {h.finding && (
                  <p className="m-0 mt-1 text-sm text-muted-foreground">
                    {h.finding}
                  </p>
                )}
                <CitedEvidence
                  ids={h.evidenceIds}
                  evidence={byId}
                  alert={alert}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {report.fixes.length > 0 && (
        <section className="mt-12">
          <SectionHeading>Proposed fix</SectionHeading>
          <ul className="m-0 flex list-none flex-col gap-4 p-0">
            {report.fixes.map((fix, i) => (
              <li key={fix.id}>
                <div className="flex items-baseline gap-2">
                  {/* Everything before the last one was turned down, and the
                      record says so rather than dropping it. */}
                  {i < report.fixes.length - 1 && (
                    <span className="text-sm text-muted-foreground uppercase tracking-[0.05em]">
                      Superseded
                    </span>
                  )}
                  <p
                    className={cn(
                      "m-0 text-sm font-medium",
                      i < report.fixes.length - 1 && "text-muted-foreground",
                    )}
                  >
                    {fix.summary}
                  </p>
                  <ConvictionMark conviction={conviction[fix.id]} />
                </div>
                <CitedEvidence
                  ids={fix.evidenceIds}
                  evidence={byId}
                  alert={alert}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {decisions.length > 0 && (
        <section className="mt-12">
          <SectionHeading>Actions taken</SectionHeading>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {decisions.map((decided) => {
              const { label, tone } = decisionView(decided);
              return (
                <li key={decided.toolUseId}>
                  <div className="flex items-baseline gap-2">
                    <StatusText tone={tone}>{label}</StatusText>
                    <span className="min-w-0 flex-1 truncate font-mono text-sm">
                      {decided.toolName}
                      {decided.target ? (
                        <span className="text-muted-foreground">
                          {" "}
                          {decided.target}
                        </span>
                      ) : null}
                    </span>
                  </div>
                  {/* Only on a failure: on a success the detail is the PR or the
                      command's own output, which the transcript already shows. */}
                  {label === "Failed" && decided.result && (
                    <p className="m-0 mt-1 text-sm text-muted-foreground">
                      {decided.result}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
