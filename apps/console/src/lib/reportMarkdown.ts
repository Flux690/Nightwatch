import type {
  SessionAlert,
  SessionReportResponse,
  Verdict,
} from "@nightwarden/shared";

// The verdict as a sentence rather than the enum, since the export is read
// outside the console where the vocabulary is not on screen to compare against.
const VERDICT_WORD: Record<Verdict, string> = {
  root_cause: "Root cause",
  trigger: "Trigger",
  symptom: "Symptom",
  contributing_factor: "Contributing factor",
  disproven: "Disproven",
  open: "Open",
};

function alertLine(entry: SessionAlert): string {
  const severity = entry.alert.labels["severity"];
  const cleared = entry.clearedAt === null ? "still firing" : "cleared";
  return `- ${entry.alert.alertType}${severity === undefined ? "" : ` (${severity})`}, fired ${entry.alert.firedAt}, ${cleared}`;
}

/* The investigation as a postmortem artifact. Only what the record holds: the
   model's prose, the system's verdicts and what actually ran. */
export function reportToMarkdown(
  title: string,
  alerts: SessionAlert[],
  report: SessionReportResponse | null,
): string {
  const sections: string[] = [`# ${title}`];

  if (alerts.length > 0) {
    sections.push(["## Alerts", "", ...alerts.map(alertLine)].join("\n"));
  }

  const claims = report?.report.hypotheses ?? [];
  if (claims.length > 0) {
    sections.push(
      [
        "## Claims",
        "",
        ...claims.map((h) => {
          const conviction = report?.conviction[h.id];
          const verdict = `${VERDICT_WORD[h.verdict]}${conviction === undefined ? "" : `, ${conviction}`}.`;
          const body = h.finding.trim();
          return `### ${h.statement}\n\n${verdict}${body === "" ? "" : `\n\n${body}`}`;
        }),
      ].join("\n"),
    );
  }

  const fixes = report?.report.fixes ?? [];
  if (fixes.length > 0) {
    sections.push(
      ["## Proposed fixes", "", ...fixes.map((f) => `- ${f.summary}`)].join(
        "\n",
      ),
    );
  }

  // What ran is the executor's log, never a claim the model made about itself.
  const actions = report?.actions ?? [];
  if (actions.length > 0) {
    sections.push(
      [
        "## What ran",
        "",
        ...actions.map(
          (a) =>
            `- ${a.toolName} - ${a.status}${a.result === null ? "" : `: ${a.result}`}`,
        ),
      ].join("\n"),
    );
  }

  return `${sections.join("\n\n")}\n`;
}
