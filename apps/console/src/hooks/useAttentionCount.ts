import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApprovalRequest, ConsoleEvent } from "@nightwatch/shared";
import { apiFetch } from "../api/client.js";
import { useConsoleWs } from "./useConsoleWs.js";

export function useAttentionCount(): number {
  const queryClient = useQueryClient();

  const { data: pending = [] } = useQuery<ApprovalRequest[]>({
    queryKey: ["sessions-pending-human-input"],
    queryFn: () =>
      apiFetch<ApprovalRequest[]>("/api/sessions/pending-human-input"),
  });

  const handleEnvelope = useCallback(
    (envelope: ConsoleEvent) => {
      // The pending list is the single source of truth. Refetch it when an
      // interrupt is raised or resolved rather than tracking a parallel delta:
      // a delta double-counts once the query independently refetches (focus,
      // remount) since the refetched list already reflects the same event.
      if (
        envelope.type === "HUMAN_INPUT_REQUIRED" ||
        envelope.type === "HUMAN_INPUT_RESOLVED"
      ) {
        void queryClient.invalidateQueries({
          queryKey: ["sessions-pending-human-input"],
        });
      }
    },
    [queryClient],
  );

  useConsoleWs(handleEnvelope);

  return pending.length;
}
