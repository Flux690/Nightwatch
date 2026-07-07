import { useQuery } from "@tanstack/react-query";
import type { GitHubIntegrationStatus } from "@nightwatch/shared";
import { apiFetch } from "@/api/client";

export function expiryDaysFrom(
  status: GitHubIntegrationStatus | undefined,
): number | null {
  if (!status?.configured || status.expiresAt === null) return null;
  return Math.ceil(
    (new Date(status.expiresAt).getTime() - Date.now()) / 86_400_000,
  );
}

// Days until the GitHub token expires, or null when not configured / not
// expiring. Hourly refetch is plenty: expiry moves on a scale of days.
export function useGitHubExpiryDays(): number | null {
  const { data } = useQuery<GitHubIntegrationStatus>({
    queryKey: ["github-integration"],
    queryFn: () =>
      apiFetch<GitHubIntegrationStatus>("/api/integrations/github"),
    refetchInterval: 60 * 60 * 1000,
  });
  return expiryDaysFrom(data);
}
