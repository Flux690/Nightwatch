import { randomUUID } from "node:crypto";
import { getDb } from "./client.js";
import { decrypt, encrypt } from "../secrets.js";

/* One table holds every configured connection. This file owns the row shape;
   each kind's own accessors read the config it wrote. */

export interface IntegrationRow {
  id: string;
  kind: string;
  name: string;
  config: Record<string, unknown>;
  // Plaintext, decrypted here so no caller has to.
  secrets: Record<string, string>;
  tokenHash: string | null;
  validatedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

interface RawRow {
  id: string;
  kind: string;
  name: string;
  config: string;
  secrets: string | null;
  token_hash: string | null;
  validated_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

const SELECT = `
  SELECT id, kind, name, config, secrets, token_hash, validated_at,
         last_used_at, created_at
  FROM integrations
`;

// A row written by an older shape, or a rotated SECRET_KEY, reads as empty
// rather than crashing every caller that touches the table.
function parseJson(text: string | null): Record<string, string> {
  if (text === null) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

function decryptSecrets(encrypted: string | null): Record<string, string> {
  if (encrypted === null) return {};
  try {
    return parseJson(decrypt(encrypted));
  } catch {
    return {};
  }
}

function toRow(raw: RawRow): IntegrationRow {
  return {
    id: raw.id,
    kind: raw.kind,
    name: raw.name,
    config: parseJson(raw.config),
    secrets: decryptSecrets(raw.secrets),
    tokenHash: raw.token_hash,
    validatedAt: raw.validated_at,
    lastUsedAt: raw.last_used_at,
    createdAt: raw.created_at,
  };
}

export function integrationsOfKind(kind: string): IntegrationRow[] {
  const rows = getDb()
    .prepare(`${SELECT} WHERE kind = ? ORDER BY created_at ASC, id ASC`)
    .all(kind) as RawRow[];
  return rows.map(toRow);
}

// For a kind only one of can exist, which the route enforces.
export function integrationOfKind(kind: string): IntegrationRow | null {
  return integrationsOfKind(kind)[0] ?? null;
}

export function integrationById(id: string): IntegrationRow | null {
  const raw = getDb().prepare(`${SELECT} WHERE id = ?`).get(id) as
    RawRow | undefined;
  return raw === undefined ? null : toRow(raw);
}

// Every row, for the unauthenticated token match and for name derivation.
export function allIntegrations(): IntegrationRow[] {
  const rows = getDb()
    .prepare(`${SELECT} ORDER BY created_at ASC, id ASC`)
    .all() as RawRow[];
  return rows.map(toRow);
}

export interface IntegrationInput {
  kind: string;
  name: string;
  config: Record<string, unknown>;
  secrets?: Record<string, string>;
  tokenHash?: string | null;
  lastUsedAt?: string | null;
}

const UPSERT = `
  INSERT INTO integrations (
    id, kind, name, config, secrets, token_hash,
    validated_at, last_used_at, created_at
  ) VALUES (
    @id, @kind, @name, @config, @secrets, @tokenHash,
    @validatedAt, @lastUsedAt, @createdAt
  )
  ON CONFLICT(id) DO UPDATE SET
    kind         = excluded.kind,
    name         = excluded.name,
    config       = excluded.config,
    secrets      = excluded.secrets,
    token_hash   = excluded.token_hash,
    validated_at = excluded.validated_at,
    last_used_at = excluded.last_used_at
`;

/* Saving means this configuration just proved itself, so validated_at bumps on
   every write; created_at survives a reconfiguration. */
export function putIntegration(
  input: IntegrationInput,
  id: string = randomUUID(),
): string {
  const now = new Date().toISOString();
  const secrets = input.secrets ?? {};
  getDb()
    .prepare(UPSERT)
    .run({
      id,
      kind: input.kind,
      name: input.name,
      config: JSON.stringify(input.config),
      secrets:
        Object.keys(secrets).length === 0
          ? null
          : encrypt(JSON.stringify(secrets)),
      tokenHash: input.tokenHash ?? null,
      validatedAt: now,
      lastUsedAt: input.lastUsedAt ?? null,
      createdAt: now,
    });
  return id;
}

export function deleteIntegrationById(id: string): boolean {
  return (
    getDb().prepare(`DELETE FROM integrations WHERE id = ?`).run(id).changes > 0
  );
}

export function deleteIntegrationsOfKind(kind: string): void {
  getDb().prepare(`DELETE FROM integrations WHERE kind = ?`).run(kind);
}

export function touchIntegration(id: string, at: string): void {
  getDb()
    .prepare(`UPDATE integrations SET last_used_at = ? WHERE id = ?`)
    .run(at, id);
}

// --- GitHub -----------------------------------------------------------------

const GITHUB = "github";

interface GitHubConfig {
  repoOwner: string;
  repoName: string;
  tokenExpiresAt: string | null;
}

export interface GitHubIntegration {
  token: string;
  repoOwner: string;
  repoName: string;
  tokenExpiresAt: string | null;
  validatedAt: string;
  createdAt: string;
}

export function getGitHubIntegration(): GitHubIntegration | null {
  const row = integrationOfKind(GITHUB);
  // GitHub always has a token: a row without one is malformed, treat as absent.
  const token = row?.secrets["token"];
  if (!row || token === undefined) return null;
  const config = row.config as unknown as GitHubConfig;
  return {
    token,
    repoOwner: config.repoOwner,
    repoName: config.repoName,
    tokenExpiresAt: config.tokenExpiresAt,
    validatedAt: row.validatedAt ?? row.createdAt,
    createdAt: row.createdAt,
  };
}

export function saveGitHubIntegration(input: {
  token: string;
  repoOwner: string;
  repoName: string;
  tokenExpiresAt: string | null;
}): void {
  const existing = integrationOfKind(GITHUB);
  putIntegration(
    {
      kind: GITHUB,
      name: "GitHub",
      config: {
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        tokenExpiresAt: input.tokenExpiresAt,
      } satisfies GitHubConfig,
      secrets: { token: input.token },
    },
    existing?.id,
  );
}

/* Credential is untouched, only the binding moves; validatedAt still bumps
   because reaching here means the stored token just proved itself live. */
export function updateGitHubIntegrationRepo(
  repoOwner: string,
  repoName: string,
): void {
  const existing = getGitHubIntegration();
  if (!existing) return;
  saveGitHubIntegration({
    token: existing.token,
    repoOwner,
    repoName,
    tokenExpiresAt: existing.tokenExpiresAt,
  });
}

export function deleteGitHubIntegration(): void {
  deleteIntegrationsOfKind(GITHUB);
}

// --- Loki -------------------------------------------------------------------

const LOKI = "loki";

interface LokiConfig {
  baseUrl: string;
  // Tenant for multi-tenant Loki (X-Scope-OrgID); null for single-binary Loki.
  orgId: string | null;
}

export interface LokiIntegration {
  baseUrl: string;
  orgId: string | null;
  authorization: string | null;
  validatedAt: string;
  createdAt: string;
}

export function getLokiIntegration(): LokiIntegration | null {
  const row = integrationOfKind(LOKI);
  if (!row) return null;
  const config = row.config as unknown as LokiConfig;
  return {
    baseUrl: config.baseUrl,
    orgId: config.orgId,
    authorization: row.secrets["authorization"] ?? null,
    validatedAt: row.validatedAt ?? row.createdAt,
    createdAt: row.createdAt,
  };
}

export function saveLokiIntegration(input: {
  baseUrl: string;
  orgId: string | null;
  authorization: string | null;
}): void {
  const existing = integrationOfKind(LOKI);
  putIntegration(
    {
      kind: LOKI,
      name: "Grafana Loki",
      config: {
        baseUrl: input.baseUrl,
        orgId: input.orgId,
      } satisfies LokiConfig,
      ...(input.authorization !== null && {
        secrets: { authorization: input.authorization },
      }),
    },
    existing?.id,
  );
}

export function deleteLokiIntegration(): void {
  deleteIntegrationsOfKind(LOKI);
}
