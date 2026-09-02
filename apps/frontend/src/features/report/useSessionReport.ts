import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { FrontendEvent, SessionReportResponse } from "@nightwarden/shared";
import { apiFetch, ApiError } from "@/shared/api/client";
import { useFrontendEvents } from "@/shared/events/FrontendEventsProvider.js";

// REPORT_UPDATED invalidates and the provider's reconnect heals a missed event.
// A 404 means nothing is recorded yet, never that the session is absent.
export function useSessionReport(
  sessionId: string | null,
): SessionReportResponse | null {
  const queryClient = useQueryClient();

  const handleEnvelope = useCallback(
    (env: FrontendEvent) => {
      if (env.type !== "REPORT_UPDATED") return;
      if (env.payload.sessionId !== sessionId) return;
      void queryClient.invalidateQueries({ queryKey: ["report", sessionId] });
    },
    [queryClient, sessionId],
  );
  useFrontendEvents(handleEnvelope);

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
