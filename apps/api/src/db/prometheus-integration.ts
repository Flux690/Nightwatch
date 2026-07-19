import { getDb } from "./client.js";

const ROW_ID = "prometheus";

export interface PrometheusIntegrationRow {
  baseUrl: string;
  authHeaderEncrypted: string | null;
  validatedAt: string;
  createdAt: string;
}

export function getPrometheusIntegration(): PrometheusIntegrationRow | null {
  const row = getDb()
    .prepare(
      `SELECT base_url, auth_header_encrypted, validated_at, created_at
       FROM prometheus_integration WHERE id = ?`,
    )
    .get(ROW_ID) as
    | {
        base_url: string;
        auth_header_encrypted: string | null;
        validated_at: string;
        created_at: string;
      }
    | undefined;
  if (!row) return null;
  return {
    baseUrl: row.base_url,
    authHeaderEncrypted: row.auth_header_encrypted,
    validatedAt: row.validated_at,
    createdAt: row.created_at,
  };
}

// Saving always means "this config just proved itself against a live probe",
// so validated_at bumps on every write; created_at survives reconfiguration.
export function savePrometheusIntegration(input: {
  baseUrl: string;
  authHeaderEncrypted: string | null;
}): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO prometheus_integration
         (id, base_url, auth_header_encrypted, validated_at, created_at)
       VALUES (@id, @baseUrl, @authHeaderEncrypted, @validatedAt, @createdAt)
       ON CONFLICT(id) DO UPDATE SET
         base_url              = excluded.base_url,
         auth_header_encrypted = excluded.auth_header_encrypted,
         validated_at          = excluded.validated_at`,
    )
    .run({
      id: ROW_ID,
      baseUrl: input.baseUrl,
      authHeaderEncrypted: input.authHeaderEncrypted,
      validatedAt: now,
      createdAt: now,
    });
}

export function deletePrometheusIntegration(): void {
  getDb()
    .prepare(`DELETE FROM prometheus_integration WHERE id = ?`)
    .run(ROW_ID);
}
