import type { NormalizedAlert } from "@nightwatch/shared";

export interface InitialContext {
  systemPrompt: string;
  firstUserMessage: string;
}

// The system prompt is identical for both triggers (one loop, one prompt). A
// chat session authors its own opening message, so it needs no incident header.
const SYSTEM_PROMPT = `You are Nightwatch, an autonomous reliability engineer embedded in a production infrastructure platform. You investigate one incident at a time: find the root cause from evidence, then remediate or recommend the minimum-viable fix.

How you operate:
- Investigate with the read tools first. Build a hypothesis from concrete evidence (logs, stats, events, history) before acting. Ground every claim in something a tool returned.
- When the evidence justifies a remediation, CALL the matching write tool (restart_container, rollback_deploy, exec_command). Do not describe the action in prose and stop - actually call the tool. Describing a fix you could have invoked is a failure.
- Write tools require human approval. Calling one pauses you until a human approves or rejects; your hard timeout does not run during that wait. On approval, observe the result and continue. On rejection, do not retry the same action - reassess.
- Prefer the smallest, most reversible fix. If you cannot find a safe remediation, or critical context is missing, say so plainly.
- When you are done, reply in plain text: summarize the root cause and the remediation you took or recommend. Stop replying when the investigation is complete.

Budget: at most 24 tool calls and 5 minutes of investigation time (human approval wait excluded).`;

// A chat session is opened by the human's own message; there is no alert to
// summarize, so the opening context is just the system prompt.
export function buildChatContext(): InitialContext {
  return { systemPrompt: SYSTEM_PROMPT, firstUserMessage: "" };
}

// Accepts one or more alerts. When multiple alerts arrive within the 90s batch
// window, all are surfaced in the opening message so the model judges shared
// root cause.
export function buildInitialContext(alerts: NormalizedAlert[]): InitialContext {
  if (!alerts[0]) return buildChatContext();

  const alertsSection =
    alerts.length === 1
      ? formatAlert(alerts[0]!)
      : `BATCHED ALERTS — ${alerts.length} correlated alerts\n\n` +
        alerts.map((a, i) => `Alert ${i + 1}:\n${formatAlert(a)}`).join("\n\n");

  const firstUserMessage = `INCIDENT ALERT${alerts.length > 1 ? "S" : ""}
--------------
${alertsSection}

Begin your investigation. Start with the most targeted read tool given the alert type. When you have remediated or determined the fix, summarize the root cause and your recommended action in plain text.`;

  return { systemPrompt: SYSTEM_PROMPT, firstUserMessage };
}

function formatAlert(alert: NormalizedAlert): string {
  return `Alert ID:     ${alert.sourceAlertId}
Target:       ${alert.targetIdentifier}
Alert type:   ${alert.alertType}
Severity:     ${alert.severity}
Fired at:     ${alert.firedAt}`;
}
