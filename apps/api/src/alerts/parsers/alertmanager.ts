import { createHash } from "node:crypto";
import { z } from "zod";
import {
  deriveServiceIdentity,
  type NormalizedAlert,
} from "@nightwatch/shared";
import { logger } from "../../logger.js";

// An alert parsed from its source, carrying a candidate identity that has not
// yet been matched against the fleet (ADR-0004 resolve-or-reject) - runnerId
// and hostname are not yet known at parse time, so they are absent rather
// than guessed.
export type ParsedAlert = Omit<NormalizedAlert, "runnerId" | "hostname">;

// Only the envelope is validated up front; each alert element is kept as unknown
// and parsed defensively in the loop, so one malformed alert in a webhook batch
// is skipped on its own instead of aborting the whole batch (ADR-0004: a bad
// sibling never suppresses the routable alerts beside it).
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
      targetIdentifier: deriveServiceIdentity(labels),
      alertType: labels["alertname"] ?? "unknown",
      severity: normalizeSeverity(labels["severity"]),
      firedAt,
      rawPayload: alert,
    });
  }

  return parsed;
}

// Alertmanager normally supplies a stable `fingerprint`. When a BYO sender omits
// it, derive a stable id from the alert's labels so the same alert dedups across
// re-fires and two distinct alerts never collide on an undefined id (which would
// drop one in dedup and overwrite the other in the unresolved feed's UNIQUE key).
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
