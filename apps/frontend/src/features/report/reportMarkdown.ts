import type {
  ResolvedEvidence,
  SessionAlert,
  SessionReportResponse,
  Verdict,
} from "@nightwarden/shared";
import { targetOf } from "@/features/session/transcript/toolPresentation";

// The verdict as a sentence rather than the enum, since the export is read
// outside the frontend where the vocabulary is not on screen to compare against.
const VERDICT_WORD: Record<Verdict, string> = {
  root_cause: "Root cause",
  trigger: "Trigger",
  symptom: "Symptom",
  contributing_factor: "Contributing factor",
  disproven: "Disproven",
  untestable: "Untestable",
};

// An exported postmortem naming a finding but not what backed it is only the
// model's word for it, and the export is read where the transcript is not.
function citedLines(
  ids: string[],
  evidence: Map<string, ResolvedEvidence>,
): string[] {
  return [...new Set(ids)].flatMap((id) => {
    const entry = evidence.get(id);
    if (entry === undefined) return [];
    const target = targetOf(entry.input);
    return [`- \`${entry.toolName}\`${target === null ? "" : ` ${target}`}`];
  });
}

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

  const byId = new Map((report?.evidence ?? []).map((e) => [e.evidenceId, e]));

  const submitted = report?.record.report ?? null;
  if (submitted !== null) {
    // Headline as its own line above the deck, since a postmortem is skimmed by
    // its first line the same way the frontend is.
    sections.push(`**${submitted.headline}**`);
    sections.push(`Affected: ${submitted.affected}`);
    sections.push(submitted.summary);
    if (submitted.timeline.length > 0) {
      sections.push(
        [
          "## What happened",
          "",
          ...submitted.timeline.map((e) => `- ${e.at} - ${e.what}`),
        ].join("\n"),
      );
    }
    if (submitted.impact.trim() !== "") {
      sections.push(["## Impact", "", submitted.impact].join("\n"));
    }
    if (submitted.recommendation.trim() !== "") {
      sections.push(
        ["## Recommendation", "", submitted.recommendation].join("\n"),
      );
    }
  }

  const claims = report?.record.findings ?? [];
  const settled = claims.filter((f) => f.verdict !== "disproven");
  const ruledOut = claims.filter((f) => f.verdict === "disproven");

  // Evidence inline, because the export outlives the frontend session it came
  // from and a verdict without it is only the model's word.
  const claimBlock = (heading: string, rows: typeof claims): string =>
    [
      `## ${heading}`,
      "",
      rows
        .map((f) => {
          const verdict = `${VERDICT_WORD[f.verdict]}.`;
          const body = f.explanation.trim();
          const cited = citedLines(f.evidenceIds, byId);
          return [
            `### ${f.statement}`,
            "",
            verdict,
            ...(body === "" ? [] : ["", body]),
            ...(cited.length === 0 ? [] : ["", "Evidence:", "", ...cited]),
          ].join("\n");
        })
        // A blank line before each heading, or the next claim's `###` lands
        // against the previous one's body and stops being a heading.
        .join("\n\n"),
    ].join("\n");

  if (settled.length > 0) sections.push(claimBlock("What held up", settled));
  if (ruledOut.length > 0) sections.push(claimBlock("Ruled out", ruledOut));

  // What the user released, read from the record rather than from anything
  // the model said about itself.
  const decisions = report?.decisions ?? [];
  if (decisions.length > 0) {
    sections.push(
      [
        "## What ran",
        "",
        ...decisions.map(
          (d) =>
            `- ${d.toolName}${d.target === null ? "" : ` ${d.target}`} - ${d.decision}${d.result === null ? "" : `: ${d.result}`}`,
        ),
      ].join("\n"),
    );
  }

  return `${sections.join("\n\n")}\n`;
}
