import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { ConfigHealth } from "@nightwarden/shared";
import { apiFetch } from "@/api/client";

// Polls app-wide setup health on a slow cadence: these states change on runner or
// integration changes (an SSE reconnect already invalidates all queries), not
// second-to-second, so a 60s poll plus focus refetch keeps the banner current.
export function useConfigHealth(): UseQueryResult<ConfigHealth> {
  return useQuery<ConfigHealth>({
    queryKey: ["config-health"],
    queryFn: () => apiFetch<ConfigHealth>("/api/config/health"),
    refetchInterval: 60_000,
  });
}
