import { useQuery } from "@tanstack/react-query";
import type { SessionListRow } from "@nightwarden/shared";
import { apiFetch } from "@/api/client";

// Derived from the session list, never fetched separately: a parallel query can
// outlive the sessions it counts, and one list means one place to invalidate.
export function useAttentionCount(): {
  count: number;
  firstSessionId: string | null;
} {
  const { data: sessions = [] } = useQuery<SessionListRow[]>({
    queryKey: ["sessions"],
    queryFn: () => apiFetch<SessionListRow[]>("/api/sessions"),
  });

  const awaiting = sessions.filter((s) => s.awaitingHumanInput);
  return {
    count: awaiting.length,
    firstSessionId: awaiting[0]?.sessionId ?? null,
  };
}
