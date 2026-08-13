import type {
  ResolvedEvidence,
  SessionAlert,
  SessionReportResponse,
  Verdict,
} from "@nightwarden/shared";
import { findingFor } from "@/components/transcript/toolFindings";
import { targetOf } from "@/components/transcript/toolPresentation";

// The verdict as a sentence rather than the enum, since the export is read
// outside the console where the vocabulary is not on screen to compare against.
const VERDICT_WORD: Record<Verdict, string> = {
  root_cause: "Root cause",
  trigger: "Trigger",
  symptom: "Symptom",
  contributing_factor: "Contributing factor",
  disproven: "Disproven",
};

/* The calls a claim rests on, carried out with it. An exported postmortem that
   names a finding but not what backed it is only the model's word for it, and
   the export is read where the transcript is not. The reading is computed from
   the recorded result, exactly as the console computes it. */
function citedLines(
  ids: string[],
  evidence: Map<string, ResolvedEvidence>,
): string[] {
  return [...new Set(ids)].flatMap((id) => {
    const entry = evidence.get(id);
    if (entry === undefined) return [];
    const target = targetOf(entry.input);
    const reading = findingFor(entry.toolName, entry.result)?.text;
    return [
      `- \`${entry.toolName}\`${target === null ? "" : ` ${target}`}${reading === undefined ? "" : ` - ${reading}`}`,
    ];
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

  const byId = new Map((report?.evidence ?? []).map((e) => [e.toolUseId, e]));

  const submitted = report?.report.submitted ?? null;
  if (submitted !== null) {
    sections.push(submitted.summary);
    if (submitted.timeline.length > 0) {
      sections.push(
        [
          "## Timeline",
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

  const claims = report?.report.hypotheses ?? [];
  const settled = claims.filter((h) => h.verdict !== "disproven");
  const ruledOut = claims.filter((h) => h.verdict === "disproven");

  // One claim with its verdict, its reason and what backs it. The evidence is
  // carried inline because the export is read where the transcript is not: a
  // verdict without it is only the model's word, in a document that outlives
  // the console session it came from.
  const claimBlock = (heading: string, rows: typeof claims): string =>
    [
      `## ${heading}`,
      "",
      rows
        .map((h) => {
          const conviction = report?.conviction[h.id];
          const verdict = `${VERDICT_WORD[h.verdict]}${conviction === undefined ? "" : `, ${conviction}`}.`;
          const body = h.finding.trim();
          const cited = citedLines(h.evidenceIds, byId);
          return [
            `### ${h.statement}`,
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

  if (settled.length > 0) sections.push(claimBlock("Findings", settled));
  if (ruledOut.length > 0) sections.push(claimBlock("Ruled out", ruledOut));

  // What the user released, read from the ledger rather than from anything
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
