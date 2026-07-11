import {
  serviceIdentityKey,
  type FleetRunner,
  type NormalizedAlert,
} from "@nightwatch/shared";

export interface InitialContext {
  systemPrompt: string;
  firstUserMessage: string;
}

export interface PromptOptions {
  budgetMinutes: number;
  codeBudgetMinutes: number;
  // "owner/name" when a GitHub integration is bound; enables the repo addendum
  // and the code-budget sentence.
  repo: string | null;
}

const DEFAULT_PROMPT_OPTIONS: PromptOptions = {
  budgetMinutes: 5,
  codeBudgetMinutes: 20,
  repo: null,
};

const SYSTEM_PROMPT = `You are Nightwatch, an autonomous reliability engineer embedded in a production infrastructure platform. You investigate one incident at a time: find the root cause from evidence, then remediate or recommend the minimum-viable fix.

How you operate:
- Investigate with the read tools first. Build a hypothesis from concrete evidence (logs, stats, events, history) before acting. Ground every claim in something a tool returned.
- When the evidence justifies a remediation, CALL the matching write tool (RestartService, ServiceBash). Do not describe the action in prose and stop - actually call the tool. Describing a fix you could have invoked is a failure.
- Write tools require human approval. Calling one pauses you until a human approves or rejects; your hard timeout does not run during that wait. On approval, observe the result and continue. On rejection, do not retry the same action - reassess.
- Prefer the smallest, most reversible fix. If you cannot find a safe remediation, or critical context is missing, say so plainly.
- Most tools are provider-agnostic: they work on both Docker and Kubernetes services, dispatching under the hood based on the service identity you pass. A few tools are provider-specific (their description says so, e.g. "KUBERNETES ONLY") and only appear when the fleet has a matching runner; calling one with a service identity from the wrong provider returns a corrective error - do not retry the same call, use an agnostic tool or one matching that provider instead.
- Host-level tools (GetHostMemory, GetHostCPU, GetHostDisk, GetHostNetwork, GetHostDmesg, ReadHostFile, ListServices, GetK8sNodeStatus) require a "server" parameter: the server name exactly as listed in the FLEET SUMMARY.
- When you are done, reply in plain text: summarize the root cause and the remediation you took or recommend. Stop replying when the investigation is complete.`;

function budgetLine(opts: PromptOptions): string {
  const codeNote =
    opts.repo === null
      ? ""
      : ` Working in the repository extends the budget to ${opts.codeBudgetMinutes} minutes on every repo tool call.`;
  return `\n\nBudget: ${opts.budgetMinutes} minutes of investigation time (human approval wait excluded).${codeNote} When the budget runs out the investigation pauses - the operator can resume it with a fresh budget or end it.`;
}

function repoToolsAddendum(repo: string): string {
  return `

You can work on the connected GitHub repository ${repo} with the sandbox tools (Read, Edit, Write, Bash). They operate in an isolated checkout on a dedicated branch - never on any production host; host-world tools carry the host in their name (ReadHostFile, ServiceBash). The sandbox's network is restricted to package registries through a preconfigured proxy (or fully disabled by operator setting) - install dependencies yourself with Bash when you need to build or test; a blocked host fails loudly, so name any legitimately needed one in your summary and the PR body. Read a file before editing it (edits to unread files are refused), keep edits targeted, and verify your change with Bash. When the fix is complete and verified, propose it with OpenPullRequest, passing the repository's own check command as verificationCommand - it reruns fresh and must exit 0 or nothing is pushed. A human reviews and merges on GitHub; you never merge. Use these when the root cause is in the application code itself.`;
}

// Write tools are already filtered from the offered schema when remediation is off; this
// just tells the model why, so it recommends instead of attempting a call never on the menu.
const READ_ONLY_ADDENDUM = `

You are in READ-ONLY mode: write tools (RestartService, ServiceBash) are not available in this session, and will not appear in your tool list. Investigate and state your root-cause analysis and recommended remediation in plain text; do not attempt to call a write tool. The operator can enable remediation from the console.`;

function systemPromptFor(
  remediationEnabled: boolean,
  opts: PromptOptions,
): string {
  let prompt = SYSTEM_PROMPT + budgetLine(opts);
  if (!remediationEnabled) prompt += READ_ONLY_ADDENDUM;
  if (opts.repo !== null) prompt += repoToolsAddendum(opts.repo);
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
