import { createHash } from "node:crypto";
import { z } from "zod";
import type { NormalizedAlert } from "@nightwarden/shared";
import { logger } from "../../logger.js";

// Parsing IS normalization: no location and no target is ever stamped on an alert.
// The labels are the whole record of what it named; matching them to a service is
// the fleet's job, at the moment the agent needs an answer.
export type ParsedAlert = NormalizedAlert;

// Only the envelope is validated up front; each alert is parsed defensively in the loop, so
// one malformed alert is skipped on its own instead of aborting the batch.
const alertmanagerWebhookSchema = z.object({
  alerts: z.array(z.unknown()),
});

export function parseAlertmanager(body: unknown): ParsedAlert[] {
  const result = alertmanagerWebhookSchema.safeParse(body);
  if (!result.success) {
    throw new Error("Invalid Alertmanager payload: missing alerts array");
  }

  const parsed: ParsedAlert[] = [];
  for (const raw of result.data.alerts) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      logger.warn({ raw }, "skipping malformed alert: not an object");
      continue;
    }
    const alert = raw as Record<string, unknown>;

    // A resolved (cleared) notification must not open an investigation - the
    // condition already recovered. Skip it rather than route it as firing.
    if (alert["status"] === "resolved") continue;

    const labels = toStringMap(alert["labels"]);
    const fingerprint =
      typeof alert["fingerprint"] === "string" &&
      alert["fingerprint"].length > 0
        ? alert["fingerprint"]
        : synthesizeFingerprint(labels);
    const firedAt =
      typeof alert["startsAt"] === "string"
        ? alert["startsAt"]
        : new Date().toISOString();

    parsed.push({
      sourceAlertId: fingerprint,
      labels,
      alertType: labels["alertname"] ?? "unknown",
      severity: normalizeSeverity(labels["severity"]),
      firedAt,
      rawPayload: alert,
    });
  }

  return parsed;
}

// Alertmanager usually supplies a stable `fingerprint`; when a BYO sender omits it, derive one
// from labels so re-fires dedup and two alerts never collide on an undefined id.
function synthesizeFingerprint(labels: Record<string, string>): string {
  const canonical = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(",");
  return (
    "synthetic-" +
    createHash("sha256").update(canonical).digest("hex").slice(0, 16)
  );
}

function toStringMap(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function normalizeSeverity(s: string | undefined): NormalizedAlert["severity"] {
  if (s === "critical" || s === "error") return "critical";
  if (s === "warning" || s === "warn") return "warning";
  return "info";
}
