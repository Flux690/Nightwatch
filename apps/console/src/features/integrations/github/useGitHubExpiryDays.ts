import type { GitHubIntegrationStatus } from "@nightwarden/shared";

export function expiryDaysFrom(
  status: GitHubIntegrationStatus | undefined,
): number | null {
  if (!status?.configured || status.expiresAt === null) return null;
  return Math.ceil(
    (new Date(status.expiresAt).getTime() - Date.now()) / 86_400_000,
  );
}
