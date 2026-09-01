import { randomBytes, timingSafeEqual } from "node:crypto";
import { hashToken } from "../fleet/runners-store.js";
import {
  allIntegrations,
  deleteIntegrationsOfKind,
  integrationOfKind,
  putIntegration,
  touchIntegration,
  type IntegrationRow,
} from "./store.js";
import { ALERT_SOURCE_KINDS } from "@nightwarden/shared";
import type { AlertSourceKind } from "@nightwarden/shared";

// The one connection whose credential we verify rather than present, so the
// only kind filling `token_hash`. The plaintext is shown once at mint.

interface AlertSourceRow {
  kind: string;
  lastReceivedAt: string | null;
  createdAt: string;
}

function isAlertSourceRow(row: IntegrationRow): boolean {
  return (ALERT_SOURCE_KINDS as readonly string[]).includes(row.kind);
}

export async function getAlertSource(
  kind: AlertSourceKind,
): Promise<AlertSourceRow | null> {
  const row = await integrationOfKind(kind);
  if (row === null) return null;
  return {
    kind: row.kind,
    lastReceivedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  };
}

/* Rotation resets the delivery stamp: deliveries made with the previous
   credential prove nothing about the new one, so status regresses to waiting. */
export async function generateAlertSourceToken(
  kind: AlertSourceKind,
): Promise<string> {
  const plaintext = `nwi_${randomBytes(32).toString("base64url")}`;
  const existing = await integrationOfKind(kind);
  await putIntegration(
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

export async function setAlertSourceReceived(
  kind: string,
  receivedAt: string,
): Promise<void> {
  const row = await integrationOfKind(kind);
  if (row !== null) await touchIntegration(row.id, receivedAt);
}

export async function deleteAlertSource(kind: AlertSourceKind): Promise<void> {
  await deleteIntegrationsOfKind(kind);
}

/* Compared in constant time against every sender rather than looked up by
   index: an indexed lookup on a secret leaks timing. Only the hash is read,
   never a stored credential. */
export async function findAlertSourceKindByToken(
  plaintext: string,
): Promise<string | null> {
  const presented = Buffer.from(hashToken(plaintext), "hex");
  for (const row of await allIntegrations()) {
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
