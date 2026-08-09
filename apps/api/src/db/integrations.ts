import { getDb } from "./client.js";

// One table, one row per integration kind, each owning a private config shape and
// an optional encrypted secret. The accessors below are the only readers, so the
// JSON stays an implementation detail and a new integration is never a new table.

interface IntegrationRow {
  config: string;
  secretEncrypted: string | null;
  validatedAt: string;
  createdAt: string;
}

function getIntegration(kind: string): IntegrationRow | null {
  const row = getDb()
    .prepare(
      `SELECT config, secret_encrypted, validated_at, created_at
       FROM integrations WHERE kind = ?`,
    )
    .get(kind) as
    | {
        config: string;
        secret_encrypted: string | null;
        validated_at: string;
        created_at: string;
      }
    | undefined;
  if (!row) return null;
  return {
    config: row.config,
    secretEncrypted: row.secret_encrypted,
    validatedAt: row.validated_at,
    createdAt: row.created_at,
  };
}

// Saving always means "this config just proved itself against a live probe", so
// validated_at bumps on every write; created_at survives reconfiguration.
function saveIntegration(
  kind: string,
  input: { config: unknown; secretEncrypted: string | null },
): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO integrations (kind, config, secret_encrypted, validated_at, created_at)
       VALUES (@kind, @config, @secretEncrypted, @validatedAt, @createdAt)
       ON CONFLICT(kind) DO UPDATE SET
         config           = excluded.config,
         secret_encrypted = excluded.secret_encrypted,
         validated_at     = excluded.validated_at`,
    )
    .run({
      kind,
      config: JSON.stringify(input.config),
      secretEncrypted: input.secretEncrypted,
      validatedAt: now,
      createdAt: now,
    });
}

function deleteIntegration(kind: string): void {
  getDb().prepare(`DELETE FROM integrations WHERE kind = ?`).run(kind);
}

const GITHUB = "github";

interface GitHubConfig {
  repoOwner: string;
  repoName: string;
  tokenExpiresAt: string | null;
}

interface GitHubIntegrationRow {
  tokenEncrypted: string;
  repoOwner: string;
  repoName: string;
  tokenExpiresAt: string | null;
  validatedAt: string;
  createdAt: string;
}

export function getGitHubIntegration(): GitHubIntegrationRow | null {
  const row = getIntegration(GITHUB);
  // GitHub always has a token: a row without one is malformed, treat as absent.
  if (!row || row.secretEncrypted === null) return null;
  const config = JSON.parse(row.config) as GitHubConfig;
  return {
    tokenEncrypted: row.secretEncrypted,
    repoOwner: config.repoOwner,
    repoName: config.repoName,
    tokenExpiresAt: config.tokenExpiresAt,
    validatedAt: row.validatedAt,
    createdAt: row.createdAt,
  };
}

export function saveGitHubIntegration(input: {
  tokenEncrypted: string;
  repoOwner: string;
  repoName: string;
  tokenExpiresAt: string | null;
}): void {
  saveIntegration(GITHUB, {
    config: {
      repoOwner: input.repoOwner,
      repoName: input.repoName,
      tokenExpiresAt: input.tokenExpiresAt,
    } satisfies GitHubConfig,
    secretEncrypted: input.tokenEncrypted,
  });
}

/* Credential is untouched, only the binding moves; validatedAt still bumps
   because reaching here means the stored token just proved itself live. */
export function updateGitHubIntegrationRepo(
  repoOwner: string,
  repoName: string,
): void {
  const existing = getGitHubIntegration();
  if (!existing) return;
  saveIntegration(GITHUB, {
    config: {
      repoOwner,
      repoName,
      tokenExpiresAt: existing.tokenExpiresAt,
    } satisfies GitHubConfig,
    secretEncrypted: existing.tokenEncrypted,
  });
}

export function deleteGitHubIntegration(): void {
  deleteIntegration(GITHUB);
}

const PROMETHEUS = "prometheus";

interface PrometheusConfig {
  baseUrl: string;
}

interface PrometheusIntegrationRow {
  baseUrl: string;
  authHeaderEncrypted: string | null;
  validatedAt: string;
  createdAt: string;
}

export function getPrometheusIntegration(): PrometheusIntegrationRow | null {
  const row = getIntegration(PROMETHEUS);
  if (!row) return null;
  const config = JSON.parse(row.config) as PrometheusConfig;
  return {
    baseUrl: config.baseUrl,
    authHeaderEncrypted: row.secretEncrypted,
    validatedAt: row.validatedAt,
    createdAt: row.createdAt,
  };
}

export function savePrometheusIntegration(input: {
  baseUrl: string;
  authHeaderEncrypted: string | null;
}): void {
  saveIntegration(PROMETHEUS, {
    config: { baseUrl: input.baseUrl } satisfies PrometheusConfig,
    secretEncrypted: input.authHeaderEncrypted,
  });
}

export function deletePrometheusIntegration(): void {
  deleteIntegration(PROMETHEUS);
}

const LOKI = "loki";

interface LokiConfig {
  baseUrl: string;
  // Tenant for multi-tenant Loki (X-Scope-OrgID); null for single-binary Loki.
  orgId: string | null;
}

interface LokiIntegrationRow {
  baseUrl: string;
  orgId: string | null;
  authHeaderEncrypted: string | null;
  validatedAt: string;
  createdAt: string;
}

export function getLokiIntegration(): LokiIntegrationRow | null {
  const row = getIntegration(LOKI);
  if (!row) return null;
  const config = JSON.parse(row.config) as LokiConfig;
  return {
    baseUrl: config.baseUrl,
    orgId: config.orgId,
    authHeaderEncrypted: row.secretEncrypted,
    validatedAt: row.validatedAt,
    createdAt: row.createdAt,
  };
}

export function saveLokiIntegration(input: {
  baseUrl: string;
  orgId: string | null;
  authHeaderEncrypted: string | null;
}): void {
  saveIntegration(LOKI, {
    config: { baseUrl: input.baseUrl, orgId: input.orgId } satisfies LokiConfig,
    secretEncrypted: input.authHeaderEncrypted,
  });
}

export function deleteLokiIntegration(): void {
  deleteIntegration(LOKI);
}
