import {
  serviceIdentityKey,
  type FleetRunner,
  type NormalizedAlert,
  type RunMode,
} from "@nightwarden/shared";
import {
  budgetLine,
  READ_ONLY_INSTRUCTIONS,
  SYSTEM_PROMPT,
  type PromptOptions,
} from "./prompts/system.js";
import { REPORT_PROTOCOL } from "./prompts/report.js";
import { sandboxInstructions } from "./prompts/sandbox.js";
import { resolveAgainstFleet } from "../alerts/resolve-target.js";

export interface InitialContext {
  systemPrompt: string;
  firstUserMessage: string;
}

const DEFAULT_PROMPT_OPTIONS: PromptOptions = {
  budgetMinutes: 5,
  codeBudgetMinutes: 20,
  repo: null,
};

function systemPromptFor(
  remediationEnabled: boolean,
  opts: PromptOptions,
  mode: RunMode,
): string {
  let prompt = SYSTEM_PROMPT + budgetLine(opts);
  if (mode === "investigate") prompt += REPORT_PROTOCOL;
  if (!remediationEnabled) prompt += READ_ONLY_INSTRUCTIONS;
  if (opts.repo !== null) prompt += sandboxInstructions(opts.repo);
  return prompt;
}

export function buildChatContext(
  remediationEnabled = false,
  fleetView?: FleetRunner[],
  opts: PromptOptions = DEFAULT_PROMPT_OPTIONS,
  mode: RunMode = "ask",
): InitialContext {
  // Chat has no alert message to carry the fleet map, so it rides the system
  // prompt - the model still needs server names for the required `server` param.
  return {
    systemPrompt:
      systemPromptFor(remediationEnabled, opts, mode) +
      buildFleetSummary(fleetView),
    firstUserMessage: "",
  };
}

// Alert-triggered sessions are always investigations, so the report protocol
// is unconditional here.
export function buildInitialContext(
  alerts: NormalizedAlert[],
  remediationEnabled = false,
  fleetView?: FleetRunner[],
  opts: PromptOptions = DEFAULT_PROMPT_OPTIONS,
): InitialContext {
  if (!alerts[0]) {
    return buildChatContext(remediationEnabled, fleetView, opts, "investigate");
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
    systemPrompt: systemPromptFor(remediationEnabled, opts, "investigate"),
    firstUserMessage,
  };
}

// Always rendered when any runner is connected, even a single one: the map carries the
// addressable server names the required `server` param needs.
function buildFleetSummary(fleetView: FleetRunner[] | undefined): string {
  if (!fleetView || fleetView.length === 0) return "";
  const lines = fleetView.map((r) => {
    const name = r.serverName ?? r.hostname;
    const identities =
      r.services.map((s) => serviceIdentityKey(s.identity)).join(", ") ||
      "no services advertised";
    return `  ${name} (remediation ${r.remediationEnabled ? "on" : "off"}): ${identities}`;
  });
  return `\nFLEET SUMMARY\n-------------\n${lines.join("\n")}\n`;
}

// Resolve the alert's candidate identity against the fleet: a resolved target names the key
// to act on; ambiguous/unresolved hand the agent the raw labels to match itself, never a guess.
function formatAlert(alert: NormalizedAlert, fleet: FleetRunner[]): string {
  const resolution = resolveAgainstFleet(alert.targetIdentifier, fleet);
  const targetLine =
    resolution.kind === "resolved"
      ? resolution.key
      : resolution.kind === "ambiguous"
        ? `ambiguous — "${resolution.key}" runs on ${resolution.servers.join(", ")}; identify which server before acting`
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
