import { createHash } from "node:crypto";
import { z } from "zod";
import type { AlertGroupContext, NormalizedAlert } from "@nightwarden/shared";
import type { DeliveryContext } from "../delivery.js";
import { logger } from "../../logger.js";

// Parsing IS normalization: no location and no target is ever stamped on an alert.
// The labels are the whole record of what it named; matching them to a service is
// the fleet's job, at the moment the agent needs an answer.
type ParsedAlert = NormalizedAlert;

// Only the envelope is validated up front; each alert is parsed defensively in the loop, so
// one malformed alert is skipped on its own instead of aborting the batch.
const alertmanagerWebhookSchema = z.object({
  alerts: z.array(z.unknown()),
  // Both Alertmanager and Grafana send these; none is required, because a
  // BYO sender mimicking the format may carry only the alerts array.
  groupKey: z.string().min(1).optional(),
  truncatedAlerts: z.number().int().nonnegative().optional(),
  groupLabels: z.unknown().optional(),
  commonLabels: z.unknown().optional(),
  commonAnnotations: z.unknown().optional(),
});

/* One delivery is one alert group. groupKey is the sender's own grouping, from
   the group_by the user configured, and trusting it is what makes grouping their
   choice. The count beside it is how many they left out of this body. */
export interface ParsedWebhook {
  groupKey: string;
  delivery: DeliveryContext;
  firing: ParsedAlert[];
  clearedIds: string[];
}

export function parseAlertmanager(body: unknown): ParsedWebhook {
  const result = alertmanagerWebhookSchema.safeParse(body);
  if (!result.success) {
    throw new Error("Invalid Alertmanager payload: missing alerts array");
  }

  const firing: ParsedAlert[] = [];
  const clearedIds: string[] = [];
  for (const raw of result.data.alerts) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      logger.warn({ raw }, "skipping malformed alert: not an object");
      continue;
    }
    const alert = raw as Record<string, unknown>;

    const labels = toStringMap(alert["labels"]);
    const fingerprint =
      typeof alert["fingerprint"] === "string" &&
      alert["fingerprint"].length > 0
        ? alert["fingerprint"]
        : synthesizeFingerprint(labels);

    if (alert["status"] === "resolved") {
      clearedIds.push(fingerprint);
      continue;
    }

    const firedAt =
      typeof alert["startsAt"] === "string"
        ? alert["startsAt"]
        : new Date().toISOString();

    firing.push({
      sourceAlertId: fingerprint,
      labels,
      annotations: toStringMap(alert["annotations"]),
      alertType: labels["alertname"] ?? "unknown",
      severity: normalizeSeverity(labels["severity"]),
      firedAt,
      // Kept verbatim: what it means is read where it is rendered, so parsing
      // still stamps nothing derived onto an alert.
      generatorURL:
        typeof alert["generatorURL"] === "string"
          ? alert["generatorURL"]
          : null,
      values: toNumberMap(alert["values"]),
      rawPayload: alert,
    });
  }

  return {
    groupKey: result.data.groupKey ?? synthesizeGroupKey(firing),
    delivery: {
      droppedAlerts: result.data.truncatedAlerts ?? 0,
      groupContext: toGroupContext(result.data),
    },
    firing,
    clearedIds,
  };
}

// Null rather than three empty maps when the sender supplied none of it, so the
// prompt can tell "grouped on nothing" from "said nothing about the group".
function toGroupContext(envelope: {
  groupLabels?: unknown;
  commonLabels?: unknown;
  commonAnnotations?: unknown;
}): AlertGroupContext | null {
  const context = {
    groupLabels: toStringMap(envelope.groupLabels),
    commonLabels: toStringMap(envelope.commonLabels),
    commonAnnotations: toStringMap(envelope.commonAnnotations),
  };
  return Object.values(context).some((m) => Object.keys(m).length > 0)
    ? context
    : null;
}

// A sender that is not Alertmanager-shaped: the delivery is the only grouping
// there is. Keyed off the fingerprints, so a redelivery dedups instead.
function synthesizeGroupKey(firing: ParsedAlert[]): string {
  const canonical = firing
    .map((a) => a.sourceAlertId)
    .sort()
    .join(",");
  return (
    "synthetic-" +
    createHash("sha256").update(canonical).digest("hex").slice(0, 16)
  );
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

// Non-finite is dropped rather than rendered: NaN and Infinity are what a
// division by zero in the rule looks like, and neither is a measurement.
function toNumberMap(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
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

// Alertmanager reserves no values, so a word outside the conventional ones is
// one we cannot rank rather than the lowest rank there is.
function normalizeSeverity(s: string | undefined): NormalizedAlert["severity"] {
  if (s === "critical" || s === "error") return "critical";
  if (s === "warning" || s === "warn") return "warning";
  if (s === "info") return "info";
  return null;
}
