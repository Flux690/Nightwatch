import {
  serviceIdentityKey,
  type FleetRunner,
  type NormalizedAlert,
} from "@nightwatch/shared";
import {
  budgetLine,
  READ_ONLY_INSTRUCTIONS,
  SYSTEM_PROMPT,
  type PromptOptions,
} from "./prompts/system.js";
import { sandboxInstructions } from "./prompts/sandbox.js";

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
): string {
  let prompt = SYSTEM_PROMPT + budgetLine(opts);
  if (!remediationEnabled) prompt += READ_ONLY_INSTRUCTIONS;
  if (opts.repo !== null) prompt += sandboxInstructions(opts.repo);
  return prompt;
}

export function buildChatContext(
  remediationEnabled = false,
  fleetView?: FleetRunner[],
  opts: PromptOptions = DEFAULT_PROMPT_OPTIONS,
): InitialContext {
  // Chat has no alert message to carry the fleet map, so it rides the system
  // prompt - the model still needs server names for the required `server` param.
  return {
    systemPrompt:
      systemPromptFor(remediationEnabled, opts) + buildFleetSummary(fleetView),
    firstUserMessage: "",
  };
}

export function buildInitialContext(
  alerts: NormalizedAlert[],
  remediationEnabled = false,
  fleetView?: FleetRunner[],
  opts: PromptOptions = DEFAULT_PROMPT_OPTIONS,
): InitialContext {
  if (!alerts[0]) return buildChatContext(remediationEnabled, fleetView, opts);

  const alertsSection =
    alerts.length === 1
      ? formatAlert(alerts[0]!)
      : `BATCHED ALERTS — ${alerts.length} correlated alerts\n\n` +
        alerts.map((a, i) => `Alert ${i + 1}:\n${formatAlert(a)}`).join("\n\n");

  const fleetSection = buildFleetSummary(fleetView);

  const firstUserMessage = `INCIDENT ALERT${alerts.length > 1 ? "S" : ""}
--------------
${alertsSection}
${fleetSection}
Begin your investigation. Start with the most targeted read tool given the alert type. When you have remediated or determined the fix, summarize the root cause and your recommended action in plain text.`;

  return {
    systemPrompt: systemPromptFor(remediationEnabled, opts),
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

function formatAlert(alert: NormalizedAlert): string {
  // JSON, not a rendered string: the model echoes this object verbatim into the `service`
  // parameter of any tool call against this target - it never reconstructs an identity.
  return `Alert ID:     ${alert.sourceAlertId}
Target:       ${JSON.stringify(alert.targetIdentifier)}
Alert type:   ${alert.alertType}
Severity:     ${alert.severity}
Fired at:     ${alert.firedAt}`;
}
