import type { FleetRunner, NormalizedAlert } from "@nightwarden/shared";
import {
  budgetLine,
  CHAT_PROMPT,
  INVESTIGATION_PROMPT,
  type PromptOptions,
} from "./prompts/system.js";
import { REPORT_PROTOCOL } from "./prompts/report.js";
import { sandboxInstructions } from "./prompts/sandbox.js";
import { resolveAlertTarget } from "../alerts/resolve-target.js";

export interface InitialContext {
  systemPrompt: string;
  // The turn NightWarden writes when no human is there to write one. Null for a
  // chat session, whose opening turn is the person's own message.
  openingTurn: string | null;
}

const DEFAULT_PROMPT_OPTIONS: PromptOptions = {
  budgetMinutes: 30,
  repo: null,
};

// Two prompts, not one with a section bolted on: a question about the fleet is
// not an incident, and telling a chat it has an investigation to shape is what
// put a stopwatch on "how many containers are running?".
function systemPromptFor(opts: PromptOptions, investigation: boolean): string {
  let prompt = investigation
    ? INVESTIGATION_PROMPT + budgetLine(opts, true) + REPORT_PROTOCOL
    : CHAT_PROMPT + budgetLine(opts, false);
  if (opts.repo !== null) prompt += sandboxInstructions(opts.repo);
  return prompt;
}

export function buildChatContext(
  fleetView?: FleetRunner[],
  opts: PromptOptions = DEFAULT_PROMPT_OPTIONS,
  investigation = false,
): InitialContext {
  // Chat has no alert message to carry the fleet map, so it rides the system
  // prompt instead - the model still needs the target keys and the names the
  // `runner` parameter is drawn from.
  return {
    systemPrompt:
      systemPromptFor(opts, investigation) + buildFleetSummary(fleetView),
    openingTurn: null,
  };
}

// Alert-triggered sessions are always investigations, so the report protocol
// is unconditional here.
export function buildInitialContext(
  alerts: NormalizedAlert[],
  fleetView?: FleetRunner[],
  opts: PromptOptions = DEFAULT_PROMPT_OPTIONS,
): InitialContext {
  if (!alerts[0]) {
    return buildChatContext(fleetView, opts, true);
  }

  const fleet = fleetView ?? [];
  const alertsSection =
    alerts.length === 1
      ? formatAlert(alerts[0]!, fleet)
      : alerts
          .map(
            (a, i) =>
              `Alert ${i + 1} of ${alerts.length}:\n${formatAlert(a, fleet)}`,
          )
          .join("\n\n");

  const opening =
    alerts.length === 1
      ? "An alert has fired. Investigate it."
      : `${alerts.length} correlated alerts have fired together. Investigate them as one incident.`;

  const openingTurn = `${opening}

<alert>
${alertsSection}
</alert>
${buildFleetSummary(fleetView)}
Begin now. Start with whichever read tool most directly addresses this alert type. When you have applied a fix or worked out what the fix should be, state the cause and that fix in plain text.`;

  return {
    systemPrompt: systemPromptFor(opts, true),
    openingTurn,
  };
}

// Rendered whenever any runner is connected: it carries the addresses the optional
// `runner` parameter is drawn from. A key two runners advertise is marked so the model
// learns it needs that parameter; which runner to pass comes from a list result.
function buildFleetSummary(fleetView: FleetRunner[] | undefined): string {
  if (!fleetView || fleetView.length === 0) return "";

  const holders = new Map<string, number>();
  for (const runner of fleetView) {
    for (const target of new Set(runner.services.map((s) => s.target))) {
      holders.set(target, (holders.get(target) ?? 0) + 1);
    }
  }

  const lines = fleetView.map((r) => {
    const name = r.serverName ?? r.hostname;
    const targets =
      r.services
        .map((s) =>
          (holders.get(s.target) ?? 0) > 1 ? `${s.target} (shared)` : s.target,
        )
        .join(", ") || "no services advertised";
    return `${name}: ${targets}`;
  });
  return `\n<fleet-summary>\nEach line names one Docker host or Kubernetes cluster, followed by the target keys it advertises. A key marked "(shared)" is advertised by more than one, so a call naming that key must also say which one you mean.\n${lines.join("\n")}\n</fleet-summary>\n`;
}

// Match the alert's labels against the fleet: a resolved target names the key to act on;
// ambiguous names the runners to choose between; unresolved hands the agent the raw labels
// to match itself, never a guess. Every label is rendered below either way.
function formatAlert(alert: NormalizedAlert, fleet: FleetRunner[]): string {
  const resolution = resolveAlertTarget(alert.labels, fleet);
  const targetLine =
    resolution.kind === "resolved"
      ? resolution.key
      : resolution.kind === "ambiguous"
        ? `${resolution.key}, which is advertised by more than one: ${resolution.runners.join(", ")}. Pass runner="<name>" on your calls to say which one you mean.`
        : "not identified. Match the labels below against a known service, or call a list tool to find it.";
  const labels = Object.entries(alert.labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  const labelLine = labels ? `\nlabels: ${labels}` : "";
  // Dropped rather than stated as null: an unrankable word is still in the
  // labels below, where the model reads it as the operator wrote it.
  const severityLine =
    alert.severity === null ? "" : `\nseverity: ${alert.severity}`;
  return `id: ${alert.sourceAlertId}
target: ${targetLine}
type: ${alert.alertType}${severityLine}
fired at: ${alert.firedAt}${labelLine}`;
}
