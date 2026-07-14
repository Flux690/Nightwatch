// Console <-> API payloads for the integrations surface. GitHub-prefixed so a
// future second integration adds its own types beside these.

export type GitHubErrorCode =
  | "invalid_token"
  | "sso_required"
  | "repo_not_found"
  | "network";

export interface GitHubIntegrationStatus {
  configured: boolean;
  repo: string | null;
  expiresAt: string | null;
  validatedAt: string | null;
}

export interface GitHubRepoSummary {
  fullName: string;
  private: boolean;
  pushedAt: string | null;
  ownerIsOrg: boolean;
}

export interface GitHubRepoPage {
  repos: GitHubRepoSummary[];
  hasMore: boolean;
}

export interface GitHubErrorBody {
  error: string;
  code: GitHubErrorCode;
  // Present on repo_not_found when the owner is an organization: GitHub 404s existence, visibility,
  // and permission failures alike, so pending org-admin approval is a plausible cause; this links straight to the approval page.
  orgApprovalUrl?: string;
}
