import { randomUUID } from "node:crypto";
import type { Selectable } from "kysely";
import { getDb } from "../db.js";
import type { Database } from "../schema.js";
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

type RawRow = Selectable<Database["integrations"]>;

const COLUMNS = [
  "id",
  "kind",
  "name",
  "config",
  "secrets",
  "token_hash",
  "validated_at",
  "last_used_at",
  "created_at",
] as const;

// A row written by an older shape, or a rotated NIGHTWARDEN_SECRET_KEY, reads as empty
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

export async function integrationsOfKind(
  kind: string,
): Promise<IntegrationRow[]> {
  const rows = await getDb()
    .selectFrom("integrations")
    .select(COLUMNS)
    .where("kind", "=", kind)
    .orderBy("created_at", "asc")
    .orderBy("id", "asc")
    .execute();
  return rows.map(toRow);
}

// For a kind only one of can exist, which the route enforces.
export async function integrationOfKind(
  kind: string,
): Promise<IntegrationRow | null> {
  return (await integrationsOfKind(kind))[0] ?? null;
}

export async function integrationById(
  id: string,
): Promise<IntegrationRow | null> {
  const raw = await getDb()
    .selectFrom("integrations")
    .select(COLUMNS)
    .where("id", "=", id)
    .executeTakeFirst();
  return raw === undefined ? null : toRow(raw);
}

// Every row, for the unauthenticated token match and for name derivation.
export async function allIntegrations(): Promise<IntegrationRow[]> {
  const rows = await getDb()
    .selectFrom("integrations")
    .select(COLUMNS)
    .orderBy("created_at", "asc")
    .orderBy("id", "asc")
    .execute();
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

/* Saving means this configuration just proved itself, so validated_at bumps on
   every write; created_at survives a reconfiguration. */
export async function putIntegration(
  input: IntegrationInput,
  id: string = randomUUID(),
): Promise<string> {
  const now = new Date().toISOString();
  const secrets = input.secrets ?? {};
  const values = {
    kind: input.kind,
    name: input.name,
    config: JSON.stringify(input.config),
    secrets:
      Object.keys(secrets).length === 0
        ? null
        : encrypt(JSON.stringify(secrets)),
    token_hash: input.tokenHash ?? null,
    validated_at: now,
    last_used_at: input.lastUsedAt ?? null,
  };
  await getDb()
    .insertInto("integrations")
    .values({ id, ...values, created_at: now })
    .onConflict((oc) => oc.column("id").doUpdateSet(values))
    .execute();
  return id;
}

export async function deleteIntegrationById(id: string): Promise<boolean> {
  const res = await getDb()
    .deleteFrom("integrations")
    .where("id", "=", id)
    .executeTakeFirst();
  return Number(res.numDeletedRows) > 0;
}

export async function deleteIntegrationsOfKind(kind: string): Promise<void> {
  await getDb().deleteFrom("integrations").where("kind", "=", kind).execute();
}

export async function touchIntegration(id: string, at: string): Promise<void> {
  await getDb()
    .updateTable("integrations")
    .set({ last_used_at: at })
    .where("id", "=", id)
    .execute();
}

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

export async function getGitHubIntegration(): Promise<GitHubIntegration | null> {
  const row = await integrationOfKind(GITHUB);
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

export async function saveGitHubIntegration(input: {
  token: string;
  repoOwner: string;
  repoName: string;
  tokenExpiresAt: string | null;
}): Promise<void> {
  const existing = await integrationOfKind(GITHUB);
  await putIntegration(
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
export async function updateGitHubIntegrationRepo(
  repoOwner: string,
  repoName: string,
): Promise<void> {
  const existing = await getGitHubIntegration();
  if (!existing) return;
  await saveGitHubIntegration({
    token: existing.token,
    repoOwner,
    repoName,
    tokenExpiresAt: existing.tokenExpiresAt,
  });
}

export async function deleteGitHubIntegration(): Promise<void> {
  await deleteIntegrationsOfKind(GITHUB);
}

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

export async function getLokiIntegration(): Promise<LokiIntegration | null> {
  const row = await integrationOfKind(LOKI);
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

export async function saveLokiIntegration(input: {
  baseUrl: string;
  orgId: string | null;
  authorization: string | null;
}): Promise<void> {
  const existing = await integrationOfKind(LOKI);
  await putIntegration(
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

export async function deleteLokiIntegration(): Promise<void> {
  await deleteIntegrationsOfKind(LOKI);
}

const SENTRY = "sentry";

interface SentryConfig {
  baseUrl: string;
  // Every Sentry path is scoped by the organization, so this addresses rather
  // than filters, and a wrong one 404s every call.
  orgSlug: string;
}

export interface SentryIntegration {
  baseUrl: string;
  orgSlug: string;
  token: string;
  validatedAt: string;
  createdAt: string;
}

export async function getSentryIntegration(): Promise<SentryIntegration | null> {
  const row = await integrationOfKind(SENTRY);
  // Sentry always has a token: a row without one is malformed, treat as absent.
  const token = row?.secrets["token"];
  if (!row || token === undefined) return null;
  const config = row.config as unknown as SentryConfig;
  return {
    baseUrl: config.baseUrl,
    orgSlug: config.orgSlug,
    token,
    validatedAt: row.validatedAt ?? row.createdAt,
    createdAt: row.createdAt,
  };
}

export async function saveSentryIntegration(input: {
  baseUrl: string;
  orgSlug: string;
  token: string;
}): Promise<void> {
  const existing = await integrationOfKind(SENTRY);
  await putIntegration(
    {
      kind: SENTRY,
      name: "Sentry",
      config: {
        baseUrl: input.baseUrl,
        orgSlug: input.orgSlug,
      } satisfies SentryConfig,
      secrets: { token: input.token },
    },
    existing?.id,
  );
}

export async function deleteSentryIntegration(): Promise<void> {
  await deleteIntegrationsOfKind(SENTRY);
}
