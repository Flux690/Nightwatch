import type {
  AlertGroupContext,
  FleetRunner,
  NormalizedAlert,
} from "@nightwarden/shared";
import type { DeliveryContext } from "../alerts/delivery.js";
import {
  FLEET,
  IDENTITY,
  budgetLine,
  HARNESS,
  INVESTIGATION,
  type PromptOptions,
} from "./prompts/system.js";
import { REPORT } from "./prompts/report.js";
import { sandboxInstructions } from "./prompts/sandbox.js";
import { resolveAlertTarget } from "../alerts/resolve-target.js";
import { stripSystemReminder } from "./system-reminder.js";

interface InitialContext {
  systemPrompt: string;
  // The turn NightWarden writes when no human is there to write one. Null for a
  // chat session, whose opening turn is the person's own message.
  openingTurn: string | null;
}

const DEFAULT_PROMPT_OPTIONS: PromptOptions = {
  budgetMinutes: 30,
  repo: null,
  fleetTools: false,
};

/* Invariant blocks first: every session shares the opening two byte for byte,
   which is the prefix a provider can cache. Only the budget line varies. */
function systemPromptFor(opts: PromptOptions, investigation: boolean): string {
  let prompt = IDENTITY + HARNESS;
  if (opts.fleetTools) prompt += FLEET;
  if (opts.repo !== null) prompt += sandboxInstructions(opts.repo);
  if (investigation) prompt += INVESTIGATION + REPORT;
  prompt += budgetLine(opts, investigation);
  return prompt;
}

export function buildChatContext(
  fleetView?: FleetRunner[],
  opts: PromptOptions = DEFAULT_PROMPT_OPTIONS,
  investigation = false,
): InitialContext {
  // Chat has no alert message to carry the fleet map, so it rides the system
  // prompt: the model still needs the target keys and the `server` names.
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
  // Rendered rather than dropped: a group shown short has to say so, and one
  // grouped on an unseen label reads as an arbitrary batch.
  delivery: DeliveryContext = { droppedAlerts: 0, groupContext: null },
): InitialContext {
  const { droppedAlerts, groupContext } = delivery;
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

  /* Stated, never guessed at. The sender says how many it left out; without this
     the agent reads a short group as the whole incident and concludes from it. */
  const droppedLine =
    droppedAlerts === 0
      ? ""
      : `\nThe alert source left ${droppedAlerts} further alert${droppedAlerts === 1 ? "" : "s"} out of this delivery, so this group is larger than what you can see here. Treat the list above as part of the incident, not all of it.\n`;

  const openingTurn = `${opening}

<alert>
${alertsSection}
</alert>
${formatGroupContext(groupContext)}${droppedLine}${buildFleetSummary(fleetView)}
Begin now. Start with whichever read tool most directly addresses this alert type. When you have applied a fix or worked out what the fix should be, state the cause and that fix in plain text.`;

  // Stripped whole: labels, annotations and group context are the sender's text,
  // and nothing we write here contains the marker for it to remove.
  return {
    systemPrompt: systemPromptFor(opts, true),
    openingTurn: stripSystemReminder(openingTurn),
  };
}

// Given rather than left to be intersected: a batch the agent cannot explain
// reads as a coincidence, and it stops looking for what the members share.
function formatGroupContext(context: AlertGroupContext | null): string {
  if (context === null) return "";
  const lines: string[] = [];
  const render = (label: string, map: Record<string, string>): void => {
    const pairs = Object.entries(map).map(([k, v]) => `${k}=${v}`);
    if (pairs.length > 0) lines.push(`${label}: ${pairs.join(", ")}`);
  };
  render("Grouped on", context.groupLabels);
  render("Held by every alert in this group", context.commonLabels);
  render("Shared annotations", context.commonAnnotations);
  return lines.length === 0 ? "" : `\n<group>\n${lines.join("\n")}\n</group>\n`;
}

// Carries both addresses: the server names, and the target keys that begin with
// them. The platform is stated per line, since a key does not carry it.
function buildFleetSummary(fleetView: FleetRunner[] | undefined): string {
  if (!fleetView || fleetView.length === 0) return "";

  const lines = fleetView.map((r) => {
    const kind = r.platform === "docker" ? "Docker host" : "Kubernetes cluster";
    const targets =
      r.services.map((s) => s.target).join(", ") || "no services advertised";
    return `${r.serverName} (${kind}): ${targets}`;
  });
  return `\n<fleet-summary>\nEach line names one server - a Docker host or a Kubernetes cluster - and the target keys it advertises. A target key begins with the name of the server it is on, so a key identifies one service on one machine and nothing else needs to say where it is.\n${lines.join("\n")}\n</fleet-summary>\n`;
}

// Prometheus puts the expression that fired in the generator link's query string,
// so the threshold costs no call. Grafana links to a rule page and carries none.
function conditionFrom(generatorURL: string | null): string | null {
  if (generatorURL === null) return null;
  try {
    const expr = new URL(generatorURL).searchParams.get("g0.expr");
    return expr !== null && expr.trim() !== "" ? expr : null;
  } catch {
    return null;
  }
}

// Rendered verbatim and never dereferenced: a runbook_url is a fact the model is
// given, not an address anything fetches.
function formatAnnotations(annotations: Record<string, string>): string {
  const entries = Object.entries(annotations);
  if (entries.length === 0) return "";
  return `\nannotations:\n${entries.map(([k, v]) => `  ${k}: ${v}`).join("\n")}`;
}

// Resolved names every key to act on, unresolved the raw labels to match.
// Never a guess, and every label renders.
function formatAlert(alert: NormalizedAlert, fleet: FleetRunner[]): string {
  const resolution = resolveAlertTarget(alert.labels, fleet);
  const targetLine =
    resolution.kind !== "resolved"
      ? "not identified. Match the labels below against a known service, or call a list tool to find it."
      : resolution.keys.length === 1
        ? resolution.keys[0]!
        : `${resolution.keys.join(", ")}. This service runs on more than one server and each of those keys is callable, but the labels do not say which one fired.`;
  const labels = Object.entries(alert.labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  const labelLine = labels ? `\nlabels: ${labels}` : "";
  // Dropped rather than stated as null: an unrankable word is still in the
  // labels below, where the model reads it as the user wrote it.
  const severityLine =
    alert.labels["severity"] === undefined
      ? ""
      : `\nseverity: ${alert.labels["severity"]}`;
  // Absent renders an empty section, never a different alert.
  const condition = conditionFrom(alert.generatorURL);
  const conditionLine =
    condition === null ? "" : `\ncondition that fired: ${condition}`;
  const linkLine =
    alert.generatorURL === null ? "" : `\nlink: ${alert.generatorURL}`;
  // The reading that tripped the rule, where the sender supplies one. It is the
  // only measurement here, so it is never the whole picture.
  const values = Object.entries(alert.values)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  const valuesLine = values ? `\nvalues at fire time: ${values}` : "";
  return `id: ${alert.sourceAlertId}
target: ${targetLine}
type: ${alert.alertType}${severityLine}
fired at: ${alert.firedAt}${labelLine}${formatAnnotations(alert.annotations)}${conditionLine}${valuesLine}${linkLine}`;
}
