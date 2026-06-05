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
    loadIncidentHistory(alert.token, alert.targetIdentifier),
  ]);

  const telemetryBlock =
    telemetrySummary.status === "fulfilled"
      ? telemetrySummary.value
      : "(telemetry unavailable)";

  const historyBlock =
    incidentHistory.status === "fulfilled"
      ? formatIncidentHistory(incidentHistory.value)
      : "(incident history unavailable)";

  const systemPrompt = `You are Nightwatch, an AI reliability engineer embedded in a production infrastructure platform.
Your job is to investigate incidents autonomously, identify root causes with evidence, and recommend (or execute with approval) the minimum-viable remediation.

Rules:
- Never guess. Use tools to gather evidence before concluding.
- Prefer read tools first; use write tools only when you have high confidence and the risk is justified.
- Write tools (restart_container, rollback_deploy, exec_command) require human approval — you will be paused until approved or rejected.
- If approved: execute and observe the result.
- If rejected: escalate with your full analysis.
- Conclude by returning a JSON object matching the InvestigationResult schema.
- Maximum tool calls: 24. Hard timeout: 5 minutes.`;

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

PAST INCIDENT HISTORY (last 30 days, this container)
------------------------------------------------------
${historyBlock}

Begin your investigation. Start with the most targeted read tool given the alert type.

When complete, output ONLY a JSON object with this exact shape (no markdown, no prose):
{
  "rootCause": {
    "summary": "...",
    "confidence": 0.0-1.0,
    "evidence": ["..."],
    "contributingFactors": ["..."]
  },
  "recommendedAction": {
    "toolName": "...",
    "targetContainer": "...",
    "params": {},
    "rationale": "...",
    "risk": "low|medium|high",
    "estimatedDowntimeSeconds": 0,
    "followUp": "..."
  } | null,
  "escalateIfRejected": true|false,
  "investigationSteps": ["..."]
}`;

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

async function loadIncidentHistory(
  token: string,
  containerName: string,
): Promise<IncidentRecord[]> {
  const result = await sendCommand(
    token,
    "get_incident_history",
    { containerName, limitDays: 30 },
    10_000,
  );
  return result as IncidentRecord[];
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
