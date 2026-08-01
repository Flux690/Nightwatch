import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConsoleEvent, SessionReportResponse } from "@nightwarden/shared";
import { apiFetch, ApiError } from "@/api/client";
import { useConsoleEvents } from "./ConsoleEventsProvider.js";

// The session's stored report, kept live: REPORT_UPDATED invalidates and the
// provider's reconnect self-heals a missed event. A 404 means no finding has
// been recorded yet; this hook never says what a session is.
export function useSessionReport(
  sessionId: string | null,
): SessionReportResponse | null {
  const queryClient = useQueryClient();

  const handleEnvelope = useCallback(
    (env: ConsoleEvent) => {
      if (env.type !== "REPORT_UPDATED") return;
      if (env.payload.sessionId !== sessionId) return;
      void queryClient.invalidateQueries({ queryKey: ["report", sessionId] });
    },
    [queryClient, sessionId],
  );
  useConsoleEvents(handleEnvelope);

  const { data = null } = useQuery<SessionReportResponse | null>({
    queryKey: ["report", sessionId],
    queryFn: () =>
      apiFetch<SessionReportResponse>(
        `/api/sessions/${sessionId}/report`,
      ).catch((err) => {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }),
    enabled: sessionId !== null,
    // The report only changes via REPORT_UPDATED (plus the provider's reconnect
    // invalidation), so event-driven freshness is the model.
    staleTime: Infinity,
  });

  return data;
}
