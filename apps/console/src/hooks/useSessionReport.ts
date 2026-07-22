import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConsoleEvent, Report } from "@nightwatch/shared";
import { apiFetch, ApiError } from "@/api/client";
import { useConsoleEvents } from "./ConsoleEventsProvider.js";

// The session's stored report, kept live: REPORT_UPDATED invalidates, and the
// provider's reconnect invalidation self-heals a missed event. A 404 is the
// legal "this is a conversation" answer, not an error.
export function useSessionReport(sessionId: string | null): Report | null {
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

  const { data = null } = useQuery<Report | null>({
    queryKey: ["report", sessionId],
    queryFn: () =>
      apiFetch<Report>(`/api/sessions/${sessionId}/report`).catch((err) => {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }),
    enabled: sessionId !== null,
  });

  return data;
}
