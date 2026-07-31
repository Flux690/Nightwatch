import { useQuery } from "@tanstack/react-query";
import type { SessionDetail } from "@nightwarden/shared";
import { apiFetch } from "@/api/client";

// The session itself: what it is, the alert that opened it, and its transcript.
// Both layout decisions read this, so neither infers a session's kind from the
// artifacts a run happened to produce.
export function useSession(sessionId: string | null): SessionDetail | null {
  const { data = null } = useQuery<SessionDetail>({
    queryKey: ["session", sessionId],
    queryFn: () => apiFetch<SessionDetail>(`/api/sessions/${sessionId}`),
    enabled: sessionId !== null,
  });
  return data;
}
