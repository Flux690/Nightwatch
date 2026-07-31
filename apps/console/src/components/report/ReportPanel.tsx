import type {
  NormalizedAlert,
  RemediationActionRecord,
  Report,
  ReportStatus,
  ResolvedEvidence,
} from "@nightwarden/shared";
import { cn } from "@/lib/utils";
import { StatusText } from "@/components/ui/status";
import { ACTION_LABEL, ACTION_TONE } from "@/lib/remediationStatus";
import { Evidence } from "./Evidence.js";

// The investigation report rendered in the main area. The claims are the
// model's; the evidence under each one is the transcript quoting itself, so
// nothing here is a description of data the system already holds.

const STATUS_LABEL: Record<ReportStatus, string> = {
  investigation_incomplete: "Investigating",
  root_cause_identified: "Root cause identified",
  inconclusive: "Inconclusive",
};

const HYPOTHESIS_LABEL = {
  root_cause: "Root cause",
  disproven: "Disproven",
  open: "Open",
} as const;

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
  // once however often it is named: a repeat is the model's slip, not a second
  // piece of evidence.
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
  alert,
}: {
  // Null until the agent records its first finding. The investigation view is
  // drawn from the session, not from this, so the panel outlives its absence.
  report: Report | null;
  actions: RemediationActionRecord[];
  // The cited calls, resolved by the API against the transcript.
  evidence: ResolvedEvidence[];
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

  return (
    <div className="mx-auto w-full max-w-page px-8 py-6">
      <header className="mb-6">
        <h1 className="m-0 text-2xl leading-snug font-semibold tracking-[-0.3px]">
          {report.headline || "Investigation"}
        </h1>
        <div className="mt-2 text-sm text-muted-foreground">
          {STATUS_LABEL[report.status]}
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
          <SectionHeading>Hypotheses</SectionHeading>
          <ul className="m-0 flex list-none flex-col gap-5 p-0">
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
                    {HYPOTHESIS_LABEL[h.state]}
                  </span>
                  <span className="text-sm text-ink-subtle">
                    {h.confidence} confidence
                  </span>
                </div>
                <p className="m-0 mt-1 text-sm">{h.statement}</p>
                {h.reason && (
                  <p className="m-0 mt-1 text-sm text-muted-foreground">
                    {h.reason}
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

      {report.recommendedFix.summary && (
        <section className="mt-6 border-t border-border pt-6">
          <SectionHeading>Recommended fix</SectionHeading>
          <p className="m-0 text-sm font-medium">
            {report.recommendedFix.summary}
          </p>
          <CitedEvidence
            ids={report.recommendedFix.evidenceIds}
            evidence={byId}
            alert={alert}
          />
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

      {report.status === "inconclusive" && !report.rootCause.summary && (
        <p className="text-sm text-muted-foreground">
          The investigation ended without identifying a root cause.
        </p>
      )}
    </div>
  );
}
