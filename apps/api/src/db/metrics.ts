import { randomUUID } from "node:crypto";
import type { MetricsBackendKind } from "@nightwarden/shared";
import { getDb } from "./client.js";

/* Rows only. Decrypting a credential and deciding what a backend can answer
   belong to integrations/metrics/backends.ts; this file knows SQL. */

export interface MetricsBackendRow {
  id: string;
  kind: MetricsBackendKind;
  label: string;
  queryUrl: string;
  queryAuthEncrypted: string | null;
  queryOrgId: string | null;
  // Null together: an endpoint without a URL is not an endpoint.
  rulesUrl: string | null;
  rulesAuthEncrypted: string | null;
  rulesOrgId: string | null;
  validatedAt: string;
  createdAt: string;
}

const SELECT = `
  SELECT id, kind, label,
         query_url            AS queryUrl,
         query_auth_encrypted AS queryAuthEncrypted,
         query_org_id         AS queryOrgId,
         rules_url            AS rulesUrl,
         rules_auth_encrypted AS rulesAuthEncrypted,
         rules_org_id         AS rulesOrgId,
         validated_at         AS validatedAt,
         created_at           AS createdAt
  FROM metrics_backends
`;

// Oldest first, so the list a user reads is the order they connected them in
// and does not reshuffle when one is re-verified.
export function listMetricsBackendRows(): MetricsBackendRow[] {
  return getDb()
    .prepare(`${SELECT} ORDER BY created_at ASC, id ASC`)
    .all() as MetricsBackendRow[];
}

export function getMetricsBackendRow(id: string): MetricsBackendRow | null {
  const row = getDb().prepare(`${SELECT} WHERE id = ?`).get(id) as
    MetricsBackendRow | undefined;
  return row ?? null;
}

export interface MetricsBackendInput {
  kind: MetricsBackendKind;
  label: string;
  queryUrl: string;
  queryAuthEncrypted: string | null;
  queryOrgId: string | null;
  rulesUrl: string | null;
  rulesAuthEncrypted: string | null;
  rulesOrgId: string | null;
}

const INSERT = `
  INSERT INTO metrics_backends (
    id, kind, label, query_url, query_auth_encrypted, query_org_id,
    rules_url, rules_auth_encrypted, rules_org_id, validated_at, created_at
  ) VALUES (
    @id, @kind, @label, @queryUrl, @queryAuthEncrypted, @queryOrgId,
    @rulesUrl, @rulesAuthEncrypted, @rulesOrgId, @validatedAt, @createdAt
  )
  ON CONFLICT(id) DO UPDATE SET
    kind                 = excluded.kind,
    label                = excluded.label,
    query_url            = excluded.query_url,
    query_auth_encrypted = excluded.query_auth_encrypted,
    query_org_id         = excluded.query_org_id,
    rules_url            = excluded.rules_url,
    rules_auth_encrypted = excluded.rules_auth_encrypted,
    rules_org_id         = excluded.rules_org_id,
    validated_at         = excluded.validated_at
`;

/* Saving always means "this configuration just proved itself against a live
   probe", so validated_at bumps on every write; created_at survives an edit. */
export function saveMetricsBackend(
  input: MetricsBackendInput,
  id = randomUUID(),
): string {
  const now = new Date().toISOString();
  getDb()
    .prepare(INSERT)
    .run({ ...input, id, validatedAt: now, createdAt: now });
  return id;
}

export function deleteMetricsBackend(id: string): boolean {
  return (
    getDb().prepare(`DELETE FROM metrics_backends WHERE id = ?`).run(id)
      .changes > 0
  );
}
