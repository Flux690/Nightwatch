import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConsoleEvent, SessionDetail } from "@nightwarden/shared";
import { apiFetch } from "@/api/client";
import { useConsoleEvents } from "./ConsoleEventsProvider.js";

// Anything that can change what this answers. The recovery sweep clears an
// alert and publishes REPORT_UPDATED, and the alert list lives here, not on the
// report, so without this an open record never learns the condition recovered.
const REFRESHES: ReadonlySet<ConsoleEvent["type"]> = new Set([
  "REPORT_UPDATED",
  "RUN_FINISHED",
  "RUN_STOPPED",
  "RUN_FAILED",
]);

// The session itself: what it is, the alert that opened it, and its transcript.
// Both layout decisions read this, so neither infers a session's kind from the
// artifacts a run happened to produce.
export function useSession(sessionId: string | null): SessionDetail | null {
  const queryClient = useQueryClient();

  const handleEnvelope = useCallback(
    (env: ConsoleEvent) => {
      if (!REFRESHES.has(env.type)) return;
      if (!("sessionId" in env.payload)) return;
      if (env.payload.sessionId !== sessionId) return;
      void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
    },
    [queryClient, sessionId],
  );
  useConsoleEvents(handleEnvelope);

  const { data = null } = useQuery<SessionDetail>({
    queryKey: ["session", sessionId],
    queryFn: () => apiFetch<SessionDetail>(`/api/sessions/${sessionId}`),
    enabled: sessionId !== null,
  });
  return data;
}
