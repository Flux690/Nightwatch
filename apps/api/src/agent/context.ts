import type {
  AlertGroupContext,
  FleetRunner,
  NormalizedAlert,
} from "@nightwarden/shared";
import type { DeliveryContext } from "../alerts/delivery.js";
import { listMetricsBackends } from "../integrations/metrics/backends.js";
import {
  budgetLine,
  CHAT_PROMPT,
  INVESTIGATION_PROMPT,
  type PromptOptions,
} from "./prompts/system.js";
import { REPORT_PROTOCOL } from "./prompts/report.js";
import { sandboxInstructions } from "./prompts/sandbox.js";
import { resolveAlertTarget } from "../alerts/resolve-target.js";

interface InitialContext {
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
      systemPromptFor(opts, investigation) +
      buildFleetSummary(fleetView) +
      buildMetricsSummary(),
    openingTurn: null,
  };
}

// Alert-triggered sessions are always investigations, so the report protocol
// is unconditional here.
export function buildInitialContext(
  alerts: NormalizedAlert[],
  fleetView?: FleetRunner[],
  opts: PromptOptions = DEFAULT_PROMPT_OPTIONS,
  // What the delivery said about itself. Rendered rather than dropped: a group
  // shown short has to say it is short, and one grouped on a label the agent
  // cannot see reads as an arbitrary batch.
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
${formatGroupContext(groupContext)}${droppedLine}${buildFleetSummary(fleetView)}${buildMetricsSummary()}
Begin now. Start with whichever read tool most directly addresses this alert type. When you have applied a fix or worked out what the fix should be, state the cause and that fix in plain text.`;

  return {
    systemPrompt: systemPromptFor(opts, true),
    openingTurn,
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

/* Only when there is a choice to make. One backend needs no name and printing
   it would invite the model to pass an argument that changes nothing; several
   make the `backend` parameter required, exactly as a shared target key makes
   `runner` required. A backend with no rules endpoint says so here rather than
   only in the result of the call that discovers it. */
function buildMetricsSummary(): string {
  const backends = listMetricsBackends();
  if (backends.length < 2) return "";
  const lines = backends.map((b) => {
    const rules =
      b.rules === null
        ? "no rules endpoint, so it cannot say whether an alerting rule is firing"
        : "serves alerting rules";
    return `${b.label}: ${b.capabilities.label}, ${rules}`;
  });
  return `\n<metrics-backends>\nMore than one metrics backend is connected, so every metrics call must name the one you mean in its "backend" argument, written exactly as it appears here.\n${lines.join("\n")}\n</metrics-backends>\n`;
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
  // labels below, where the model reads it as the user wrote it.
  const severityLine =
    alert.severity === null ? "" : `\nseverity: ${alert.severity}`;
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
