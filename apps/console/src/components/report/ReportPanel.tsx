import type {
  Conviction,
  NormalizedAlert,
  RemediationActionRecord,
  Report,
  ReportConviction,
  ResolvedEvidence,
  Verdict,
} from "@nightwarden/shared";
import { cn } from "@/lib/utils";
import { StatusText } from "@/components/ui/status";
import { ACTION_LABEL, ACTION_TONE } from "@/lib/remediationStatus";
import { Evidence } from "./Evidence.js";

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
    <h2 className="mb-2 text-sm font-medium uppercase tracking-[0.06em] text-muted-foreground">
      {children}
    </h2>
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
    <div className="mt-1.5">
      {cited.map((entry) => (
        <Evidence key={entry.toolUseId} entry={entry} alert={alert} />
      ))}
    </div>
  );
}

export function ReportPanel({
  report,
  actions,
  evidence,
  conviction,
  alert,
}: {
  // Null until the agent records its first finding. The investigation view is
  // drawn from the session, not from this, so the panel outlives its absence.
  report: Report | null;
  actions: RemediationActionRecord[];
  // The cited calls, resolved by the API against the transcript.
  evidence: ResolvedEvidence[];
  conviction: ReportConviction;
  alert: NormalizedAlert | null;
}): React.JSX.Element {
  if (report === null) {
    return (
      <div className="mx-auto w-full max-w-page px-8 py-6">
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
    <div className="mx-auto w-full max-w-page px-8 py-6">
      <header className="mb-6">
        <h1 className="m-0 text-2xl leading-snug font-semibold tracking-[-0.3px]">
          Investigation
        </h1>
        {rootCause !== undefined && (
          <p className="m-0 mt-2 text-base font-medium">
            {rootCause.statement}
          </p>
        )}
      </header>

      {report.hypotheses.length > 0 && (
        <section className="mt-6 border-t border-border pt-6">
          <SectionHeading>Hypotheses</SectionHeading>
          <ul className="m-0 flex list-none flex-col gap-5 p-0">
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
        <section className="mt-6 border-t border-border pt-6">
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

      {actions.length > 0 && (
        <section className="mt-6 border-t border-border pt-6">
          <SectionHeading>Actions taken</SectionHeading>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {actions.map((action) => (
              <li key={action.toolUseId}>
                <div className="flex items-baseline gap-2">
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
                      {action.status === "rejected" ? "declined" : "approved"}{" "}
                      by {action.resolvedBy}
                    </span>
                  )}
                </div>
                {/* Only on a failure: on a success the detail is the PR or the
                    command's own output, which the transcript already shows. */}
                {action.status === "failed" && action.result && (
                  <p className="m-0 mt-0.5 text-sm text-muted-foreground">
                    {action.result}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
