// Console <-> API payloads for the integrations surface. Provider-prefixed so
// each integration's types sit beside the others without colliding.

export type GitHubErrorCode =
  "invalid_token" | "sso_required" | "repo_not_found" | "network";

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

export type LokiErrorCode =
  "network" | "unauthorized" | "bad_query" | "bad_response";

export interface LokiIntegrationStatus {
  configured: boolean;
  url: string | null;
  // Whether an Authorization header is stored - the value itself never leaves the API.
  hasAuth: boolean;
  // Whether a multi-tenant X-Scope-OrgID tenant is stored.
  hasOrgId: boolean;
  validatedAt: string | null;
}
