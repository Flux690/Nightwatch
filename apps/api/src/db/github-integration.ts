import { getDb } from "./client.js";

const ROW_ID = "github";

export interface GitHubIntegrationRow {
  tokenEncrypted: string;
  repoOwner: string;
  repoName: string;
  tokenExpiresAt: string | null;
  validatedAt: string;
  createdAt: string;
}

export function getGitHubIntegration(): GitHubIntegrationRow | null {
  const row = getDb()
    .prepare(
      `SELECT token_encrypted, repo_owner, repo_name, token_expires_at, validated_at, created_at
       FROM github_integration WHERE id = ?`,
    )
    .get(ROW_ID) as
    | {
        token_encrypted: string;
        repo_owner: string;
        repo_name: string;
        token_expires_at: string | null;
        validated_at: string;
        created_at: string;
      }
    | undefined;
  if (!row) return null;
  return {
    tokenEncrypted: row.token_encrypted,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    tokenExpiresAt: row.token_expires_at,
    validatedAt: row.validated_at,
    createdAt: row.created_at,
  };
}

export function saveGitHubIntegration(input: {
  tokenEncrypted: string;
  repoOwner: string;
  repoName: string;
  tokenExpiresAt: string | null;
}): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO github_integration
         (id, token_encrypted, repo_owner, repo_name, token_expires_at, validated_at, created_at)
       VALUES (@id, @tokenEncrypted, @repoOwner, @repoName, @tokenExpiresAt, @validatedAt, @createdAt)
       ON CONFLICT(id) DO UPDATE SET
         token_encrypted  = excluded.token_encrypted,
         repo_owner       = excluded.repo_owner,
         repo_name        = excluded.repo_name,
         token_expires_at = excluded.token_expires_at,
         validated_at     = excluded.validated_at`,
    )
    .run({
      id: ROW_ID,
      tokenEncrypted: input.tokenEncrypted,
      repoOwner: input.repoOwner,
      repoName: input.repoName,
      tokenExpiresAt: input.tokenExpiresAt,
      validatedAt: now,
      createdAt: now,
    });
}

export function deleteGitHubIntegration(): void {
  getDb().prepare(`DELETE FROM github_integration WHERE id = ?`).run(ROW_ID);
}
