import { randomBytes, timingSafeEqual } from "node:crypto";
import { hashToken } from "./runner.js";
import {
  allIntegrations,
  deleteIntegrationsOfKind,
  integrationOfKind,
  putIntegration,
  touchIntegration,
  type IntegrationRow,
} from "./integrations.js";
import { ALERT_SOURCE_KINDS } from "@nightwarden/shared";
import type { AlertSourceKind } from "@nightwarden/shared";

/* An alert source is the one connection whose credential we verify rather than
   present, so it is the only kind that fills `token_hash`. Nothing stores a
   readable copy: the plaintext is shown once at mint and never again. */

interface AlertSourceRow {
  kind: string;
  lastReceivedAt: string | null;
  createdAt: string;
}

function isAlertSourceRow(row: IntegrationRow): boolean {
  return (ALERT_SOURCE_KINDS as readonly string[]).includes(row.kind);
}

export function getAlertSource(kind: AlertSourceKind): AlertSourceRow | null {
  const row = integrationOfKind(kind);
  if (row === null) return null;
  return {
    kind: row.kind,
    lastReceivedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  };
}

/* Rotation resets the delivery stamp: deliveries made with the previous
   credential prove nothing about the new one, so status regresses to waiting. */
export function generateAlertSourceToken(kind: AlertSourceKind): string {
  const plaintext = `nwi_${randomBytes(32).toString("base64url")}`;
  const existing = integrationOfKind(kind);
  putIntegration(
    {
      kind,
      name:
        kind === "alertmanager"
          ? "Prometheus Alertmanager"
          : "Grafana Alerting",
      config: {},
      tokenHash: hashToken(plaintext),
      lastUsedAt: null,
    },
    existing?.id,
  );
  return plaintext;
}

export function setAlertSourceReceived(kind: string, receivedAt: string): void {
  const row = integrationOfKind(kind);
  if (row !== null) touchIntegration(row.id, receivedAt);
}

export function deleteAlertSource(kind: AlertSourceKind): void {
  deleteIntegrationsOfKind(kind);
}

/* Compared in constant time against every sender rather than looked up by
   index: an indexed lookup on a secret leaks timing. Only the hash is read,
   never a stored credential. */
export function findAlertSourceKindByToken(plaintext: string): string | null {
  const presented = Buffer.from(hashToken(plaintext), "hex");
  for (const row of allIntegrations()) {
    if (!isAlertSourceRow(row) || row.tokenHash === null) continue;
    const stored = Buffer.from(row.tokenHash, "hex");
    if (
      stored.length === presented.length &&
      timingSafeEqual(stored, presented)
    ) {
      return row.kind;
    }
  }
  return null;
}
