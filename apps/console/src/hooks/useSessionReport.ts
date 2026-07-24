import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConsoleEvent, Report } from "@nightwarden/shared";
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
    // The report only changes via REPORT_UPDATED (plus the provider's
    // reconnect invalidation), so event-driven freshness is the model - and it
    // lets an optimistic seed survive until a real event replaces it.
    staleTime: Infinity,
  });

  return data;
}

// Seeded into the query cache the moment a send commits to investigate, so the
// layout morphs immediately; the first real REPORT_UPDATED replaces it, and a
// failed send rolls it back.
export function optimisticReport(): Report {
  return {
    status: "investigation_incomplete",
    headline: "",
    rootCause: { summary: "", detail: "" },
    hypotheses: [],
    evidence: [],
    proposedFix: { summary: "", steps: [], evidenceIds: [] },
    updatedAt: new Date().toISOString(),
    model: "",
  };
}
