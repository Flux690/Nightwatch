import { redis } from "../redis/client.js";
import { sendCommand } from "../ws/router.js";
import type { NormalizedAlert, IncidentRecord } from "@nightwatch/shared";

export interface InitialContext {
  systemPrompt: string;
  firstUserMessage: string;
}

export async function buildInitialContext(
  alert: NormalizedAlert,
): Promise<InitialContext> {
  const [telemetrySummary, incidentHistory] = await Promise.allSettled([
    loadTelemetrySummary(alert.token),
    loadIncidentHistory(alert.token, alert.targetIdentifier, alert.alertType),
  ]);

  const telemetryBlock =
    telemetrySummary.status === "fulfilled"
      ? telemetrySummary.value
      : "(telemetry unavailable)";

  const historyBlock =
    incidentHistory.status === "fulfilled"
      ? formatIncidentHistory(incidentHistory.value)
      : "(incident history unavailable)";

  const systemPrompt = `You are Nightwatch, an autonomous reliability engineer embedded in a production infrastructure platform. You investigate one incident at a time: find the root cause from evidence, then remediate or recommend the minimum-viable fix.

How you operate:
- Investigate with the read tools first. Build a hypothesis from concrete evidence (logs, stats, events, history) before acting. Ground every claim in something a tool returned.
- When the evidence justifies a remediation, CALL the matching write tool (restart_container, rollback_deploy, exec_command). Do not describe the action in prose and stop - actually call the tool. Describing a fix you could have invoked is a failure.
- Write tools require human approval. Calling one pauses you until a human approves or rejects; your hard timeout does not run during that wait. On approval, observe the result and continue. On rejection, do not retry the same action - reassess or escalate.
- Prefer the smallest, most reversible fix. If you cannot find a safe remediation, or critical context is missing, say so in your conclusion and set escalateIfRejected.
- Finish by calling the conclude tool exactly once with your structured result. Never end the investigation with a prose summary - the conclude tool is the only valid ending.

Budget: at most 24 tool calls and 5 minutes of investigation time (human approval wait excluded).`;

  const firstUserMessage = `INCIDENT ALERT
--------------
Alert ID:     ${alert.sourceAlertId}
Token:        ${alert.token}
Target:       ${alert.targetIdentifier}
Alert type:   ${alert.alertType}
Severity:     ${alert.severity}
Fired at:     ${alert.firedAt}

RECENT TELEMETRY (last 2h)
--------------------------
${telemetryBlock}

PAST INCIDENT HISTORY (last 30 days, this container + alert type)
----------------------------------------------------------------
${historyBlock}

Begin your investigation. Start with the most targeted read tool given the alert type. When you have remediated or determined the fix, call the conclude tool to finish.`;

  return { systemPrompt, firstUserMessage };
}

async function loadTelemetrySummary(token: string): Promise<string> {
  const keys = await redis.keys(`telemetry:${token}:*`);
  if (keys.length === 0) return "(no recent telemetry snapshots found)";

  const latest = keys.sort().slice(-3);
  const snapshots = await Promise.all(latest.map((k) => redis.get(k)));

  const lines: string[] = [];
  for (const raw of snapshots) {
    if (!raw) continue;
    try {
      const snap = JSON.parse(raw) as {
        capturedAt: string;
        host: { memoryPercent: number; loadAvg1m: number };
        metrics: Array<{
          containerName: string;
          cpuPercent: number;
          memoryPercent: number;
          status: string;
        }>;
      };
      lines.push(
        `[${snap.capturedAt}] host mem=${snap.host.memoryPercent.toFixed(1)}% load=${snap.host.loadAvg1m.toFixed(2)}`,
      );
      for (const m of snap.metrics) {
        lines.push(
          `  ${m.containerName}: cpu=${m.cpuPercent.toFixed(1)}% mem=${m.memoryPercent.toFixed(1)}% status=${m.status}`,
        );
      }
    } catch {
      // skip malformed snapshots
    }
  }

  return lines.length > 0 ? lines.join("\n") : "(no parseable snapshots)";
}

const MAX_HISTORY_RECORDS = 5;

async function loadIncidentHistory(
  token: string,
  containerName: string,
  alertType: string,
): Promise<IncidentRecord[]> {
  const result = await sendCommand(
    token,
    "get_incident_history",
    { containerName, alertType, limitDays: 30 },
    10_000,
  );
  // The runner's get_incident_history handler returns IncidentRecord[]; the WS
  // command contract has no per-command typing, so this shape is asserted.
  return collapseHistory(result as IncidentRecord[]);
}

// Same root cause recurring is one signal, not five. Collapse duplicates into a
// single representative (the newest) carrying an occurrence count, then cap.
function collapseHistory(records: IncidentRecord[]): IncidentRecord[] {
  const byCause = new Map<string, IncidentRecord>();
  for (const record of records) {
    const existing = byCause.get(record.rootCause);
    if (!existing) {
      byCause.set(record.rootCause, { ...record, recurrenceCount: 1 });
      continue;
    }
    const newest = record.timestamp > existing.timestamp ? record : existing;
    byCause.set(record.rootCause, {
      ...newest,
      recurrenceCount: existing.recurrenceCount + 1,
    });
  }
  return [...byCause.values()]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, MAX_HISTORY_RECORDS);
}

function formatIncidentHistory(records: IncidentRecord[]): string {
  if (records.length === 0) return "(no past incidents)";
  return records
    .map(
      (r) =>
        `[${r.timestamp}] ${r.alertType} — ${r.rootCause} — action: ${r.resolutionAction ?? "none"} (recurrences: ${r.recurrenceCount})`,
    )
    .join("\n");
}
