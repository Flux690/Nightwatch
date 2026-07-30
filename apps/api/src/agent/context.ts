import type {
  FleetRunner,
  NormalizedAlert,
  RunMode,
} from "@nightwarden/shared";
import {
  budgetLine,
  SYSTEM_PROMPT,
  type PromptOptions,
} from "./prompts/system.js";
import { REPORT_PROTOCOL } from "./prompts/report.js";
import { sandboxInstructions } from "./prompts/sandbox.js";
import { resolveAlertTarget } from "../alerts/resolve-target.js";

export interface InitialContext {
  systemPrompt: string;
  firstUserMessage: string;
}

const DEFAULT_PROMPT_OPTIONS: PromptOptions = {
  budgetMinutes: 30,
  repo: null,
};

function systemPromptFor(opts: PromptOptions, mode: RunMode): string {
  let prompt = SYSTEM_PROMPT + budgetLine(opts);
  if (mode === "investigate") prompt += REPORT_PROTOCOL;
  if (opts.repo !== null) prompt += sandboxInstructions(opts.repo);
  return prompt;
}

export function buildChatContext(
  fleetView?: FleetRunner[],
  opts: PromptOptions = DEFAULT_PROMPT_OPTIONS,
  mode: RunMode = "ask",
): InitialContext {
  // Chat has no alert message to carry the fleet map, so it rides the system
  // prompt - the model still needs server names for the required `server` param.
  return {
    systemPrompt: systemPromptFor(opts, mode) + buildFleetSummary(fleetView),
    firstUserMessage: "",
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
    return buildChatContext(fleetView, opts, "investigate");
  }

  const fleet = fleetView ?? [];
  const alertsSection =
    alerts.length === 1
      ? formatAlert(alerts[0]!, fleet)
      : `BATCHED ALERTS — ${alerts.length} correlated alerts\n\n` +
        alerts
          .map((a, i) => `Alert ${i + 1}:\n${formatAlert(a, fleet)}`)
          .join("\n\n");

  const fleetSection = buildFleetSummary(fleetView);

  const firstUserMessage = `INCIDENT ALERT${alerts.length > 1 ? "S" : ""}
--------------
${alertsSection}
${fleetSection}
Begin your investigation. Start with the most targeted read tool given the alert type. When you have remediated or determined the fix, summarize the root cause and your recommended action in plain text.`;

  return {
    systemPrompt: systemPromptFor(opts, "investigate"),
    firstUserMessage,
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
    return `  ${name}: ${targets}`;
  });
  return `\nFLEET SUMMARY\n-------------\n${lines.join("\n")}\n`;
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
        ? `${resolution.key} — advertised by ${resolution.runners.join(", ")}. Pass runner="<name>" on your calls to pick one.`
        : "unidentified — match the labels below to a known service, or use a list tool";
  const labels = Object.entries(alert.labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  const labelLine = labels ? `\nLabels:       ${labels}` : "";
  return `Alert ID:     ${alert.sourceAlertId}
Target:       ${targetLine}
Alert type:   ${alert.alertType}
Severity:     ${alert.severity}
Fired at:     ${alert.firedAt}${labelLine}`;
}
