import {
  serviceIdentityKey,
  type FleetRunner,
  type NormalizedAlert,
  type ServiceManifestEntry,
} from "@nightwatch/shared";

export interface InitialContext {
  systemPrompt: string;
  firstUserMessage: string;
}

const SYSTEM_PROMPT = `You are Nightwatch, an autonomous reliability engineer embedded in a production infrastructure platform. You investigate one incident at a time: find the root cause from evidence, then remediate or recommend the minimum-viable fix.

How you operate:
- Investigate with the read tools first. Build a hypothesis from concrete evidence (logs, stats, events, history) before acting. Ground every claim in something a tool returned.
- When the evidence justifies a remediation, CALL the matching write tool (restart_service, exec_command). Do not describe the action in prose and stop - actually call the tool. Describing a fix you could have invoked is a failure.
- Write tools require human approval. Calling one pauses you until a human approves or rejects; your hard timeout does not run during that wait. On approval, observe the result and continue. On rejection, do not retry the same action - reassess.
- Prefer the smallest, most reversible fix. If you cannot find a safe remediation, or critical context is missing, say so plainly.
- Most tools are provider-agnostic: they work on both Docker and Kubernetes services, dispatching under the hood based on the service identity you pass. A few tools are provider-specific (their description says so, e.g. "KUBERNETES ONLY") and only appear when the fleet has a matching runner; calling one with a service identity from the wrong provider returns a corrective error - do not retry the same call, use an agnostic tool or one matching that provider instead.
- When you are done, reply in plain text: summarize the root cause and the remediation you took or recommend. Stop replying when the investigation is complete.

Budget: 5 minutes of investigation time (human approval wait excluded). When the budget runs out the investigation pauses - the operator can resume it with a fresh budget or end it.`;

// Appended when the runner has remediation off (the default for a fresh
// runner). Write tools are filtered out of the offered schema entirely
// (getToolSchemas in agent/tools.ts) - this just tells the model why, so it
// recommends instead of attempting a call that was never on the menu.
const READ_ONLY_ADDENDUM = `

You are in READ-ONLY mode: write tools (restart_service, exec_command) are not available in this session, and will not appear in your tool list. Investigate and state your root-cause analysis and recommended remediation in plain text; do not attempt to call a write tool. To enable remediation, set REMEDIATION_ENABLED=true on the runner and reconnect it.`;

function systemPromptFor(remediationEnabled: boolean): string {
  return remediationEnabled
    ? SYSTEM_PROMPT
    : SYSTEM_PROMPT + READ_ONLY_ADDENDUM;
}

export function buildChatContext(remediationEnabled = false): InitialContext {
  return {
    systemPrompt: systemPromptFor(remediationEnabled),
    firstUserMessage: "",
  };
}

export function buildInitialContext(
  alerts: NormalizedAlert[],
  serviceSnapshot?: ServiceManifestEntry[],
  remediationEnabled = false,
  fleetView?: FleetRunner[],
): InitialContext {
  if (!alerts[0]) return buildChatContext(remediationEnabled);

  const alertsSection =
    alerts.length === 1
      ? formatAlert(alerts[0]!)
      : `BATCHED ALERTS — ${alerts.length} correlated alerts\n\n` +
        alerts.map((a, i) => `Alert ${i + 1}:\n${formatAlert(a)}`).join("\n\n");

  const snapshotSection =
    serviceSnapshot && serviceSnapshot.length > 0
      ? `\nSERVICE SNAPSHOT (same runner)\n` +
        `------------------------------\n` +
        serviceSnapshot
          .map(
            (e) => `  ${serviceIdentityKey(e.identity).padEnd(40)} ${e.status}`,
          )
          .join("\n") +
        "\n"
      : "";

  const fleetSection = buildFleetSummary(fleetView);

  const firstUserMessage = `INCIDENT ALERT${alerts.length > 1 ? "S" : ""}
--------------
${alertsSection}
${snapshotSection}${fleetSection}
Begin your investigation. Start with the most targeted read tool given the alert type. When you have remediated or determined the fix, summarize the root cause and your recommended action in plain text.`;

  return {
    systemPrompt: systemPromptFor(remediationEnabled),
    firstUserMessage,
  };
}

function buildFleetSummary(fleetView: FleetRunner[] | undefined): string {
  if (!fleetView || fleetView.length <= 1) return "";
  const lines = fleetView
    .filter((r) => r.services.length > 0)
    .map((r) => {
      const identities = r.services
        .map((s) => serviceIdentityKey(s.identity))
        .join(", ");
      return `  ${r.hostname}: ${identities}`;
    });
  if (lines.length === 0) return "";
  return `\nFLEET SUMMARY\n-------------\n${lines.join("\n")}\n`;
}

function formatAlert(alert: NormalizedAlert): string {
  // JSON, not a rendered string: the model echoes this object verbatim into
  // the `service` parameter of any tool call against this target (PRD
  // "Further Notes" - the agent echoes the identity, it never reconstructs one).
  return `Alert ID:     ${alert.sourceAlertId}
Target:       ${JSON.stringify(alert.targetIdentifier)}
Alert type:   ${alert.alertType}
Severity:     ${alert.severity}
Fired at:     ${alert.firedAt}`;
}
