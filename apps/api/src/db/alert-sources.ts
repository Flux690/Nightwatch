import { randomBytes, timingSafeEqual } from "node:crypto";
import { getDb } from "./client.js";
import { hashToken } from "./runner.js";
import { encrypt, decrypt } from "../secrets.js";
import type { AlertSourceKind } from "@nightwarden/shared";

interface AlertSourceRow {
  kind: string;
  lastReceivedAt: string | null;
  createdAt: string;
}

export function getAlertSource(kind: AlertSourceKind): AlertSourceRow | null {
  const row = getDb()
    .prepare(
      `SELECT kind, last_received_at, created_at FROM alert_sources WHERE kind = ?`,
    )
    .get(kind) as
    | { kind: string; last_received_at: string | null; created_at: string }
    | undefined;
  if (!row) return null;
  return {
    kind: row.kind,
    lastReceivedAt: row.last_received_at,
    createdAt: row.created_at,
  };
}

// Rotation resets last_received_at: deliveries made with the previous
// credential prove nothing about the new one, so status regresses to waiting.
export function generateAlertSourceToken(kind: AlertSourceKind): string {
  const plaintext = "nwi_" + randomBytes(32).toString("base64url");
  getDb()
    .prepare(
      `INSERT INTO alert_sources (kind, token_hash, token_encrypted, last_received_at, created_at)
       VALUES (@kind, @hash, @encrypted, NULL, @createdAt)
       ON CONFLICT(kind) DO UPDATE SET
         token_hash       = excluded.token_hash,
         token_encrypted  = excluded.token_encrypted,
         last_received_at = NULL`,
    )
    .run({
      kind,
      hash: hashToken(plaintext),
      encrypted: encrypt(plaintext),
      createdAt: new Date().toISOString(),
    });
  return plaintext;
}

export function getAlertSourcePlaintext(kind: AlertSourceKind): string | null {
  const row = getDb()
    .prepare(`SELECT token_encrypted FROM alert_sources WHERE kind = ?`)
    .get(kind) as { token_encrypted: string } | undefined;
  if (!row) return null;
  return decrypt(row.token_encrypted);
}

export function setAlertSourceReceived(kind: string, receivedAt: string): void {
  getDb()
    .prepare(
      `UPDATE alert_sources SET last_received_at = @receivedAt WHERE kind = @kind`,
    )
    .run({ kind, receivedAt });
}

// Constant-time compare per row so token validation leaks no timing
// information; the handful of source rows makes the scan trivial.
export function findAlertSourceKindByToken(plaintext: string): string | null {
  const presented = Buffer.from(hashToken(plaintext), "hex");
  const rows = getDb()
    .prepare(`SELECT kind, token_hash FROM alert_sources`)
    .all() as Array<{ kind: string; token_hash: string }>;
  for (const row of rows) {
    const stored = Buffer.from(row.token_hash, "hex");
    if (
      stored.length === presented.length &&
      timingSafeEqual(stored, presented)
    ) {
      return row.kind;
    }
  }
  return null;
}
